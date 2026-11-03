// src/client/smart-segmentation-worker.ts
var worker = self;
worker.onmessage = async ({ data }) => {
  const urls = [];
  let encoder, decoder;
  const moduleURL = (bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "text/javascript" }));
    urls.push(url);
    return url;
  };
  try {
    const ort = await import(
      /* @vite-ignore */
      moduleURL(data.runtime.ort)
    );
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const wasm = URL.createObjectURL(new Blob([new Uint8Array(data.runtime.wasm)], { type: "application/wasm" }));
    urls.push(wasm);
    ort.env.wasm.wasmPaths = { mjs: moduleURL(data.runtime.binding), wasm };
    encoder = await ort.InferenceSession.create(data.runtime.encoder, { executionProviders: ["wasm"] });
    decoder = await ort.InferenceSession.create(data.runtime.decoder, { executionProviders: ["wasm"] });
    const outputs = [];
    for (const job of data.jobs) {
      const input = new OffscreenCanvas(job.width, job.height), ic = input.getContext("2d");
      ic.putImageData(new ImageData(new Uint8ClampedArray(job.rgba), job.width, job.height), 0, 0);
      const scale = 1024 / Math.max(job.width, job.height), w = Math.round(job.width * scale), h = Math.round(job.height * scale);
      const canvas = new OffscreenCanvas(1024, 1024), ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(input, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, 1024, 1024).data;
      const pixels = new Float32Array(3 * 1024 * 1024), mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) pixels[c * 1024 * 1024 + y * 1024 + x] = (rgba[(y * 1024 + x) * 4 + c] - mean[c]) / std[c];
      const embeddings = await encoder.run({ pixel_values: new ort.Tensor("float32", pixels, [1, 3, 1024, 1024]) });
      const prompts = job.proposals ? Array.from({ length: 25 }, (_, i) => [0.1 + i % 5 * 0.2, 0.1 + Math.floor(i / 5) * 0.2]) : [null];
      const candidates = [];
      for (const seed of prompts) {
        const points = seed ? [seed, [-1, -1]] : [[0.04, 0.04], [0.96, 0.96], ...job.positive, ...job.negative];
        const labels = seed ? [1, -1] : [2, 3, ...job.positive.map(() => 1), ...job.negative.map(() => 0)];
        const result = await decoder.run({
          ...embeddings,
          input_points: new ort.Tensor("float32", Float32Array.from(points.flatMap(([x, y]) => [x * w, y * h])), [1, 1, points.length, 2]),
          input_labels: new ort.Tensor("int64", BigInt64Array.from(labels.map(BigInt)), [1, 1, labels.length])
        });
        for (let m = 0; m < 3; m++) {
          const score = Number(result.iou_scores.data[m]);
          if (score < 0.25) continue;
          const mask = new Uint8Array(256 * 256);
          let area = 0;
          for (let y = 0; y < Math.ceil(h / 4); y++) for (let x = 0; x < Math.ceil(w / 4); x++) {
            const p = y * 256 + x;
            if (result.pred_masks.data[m * mask.length + p] > 0) {
              mask[p] = 255;
              area++;
            }
          }
          const coverage = area / Math.max(1, w * h / 16);
          if (coverage < 2e-3 || coverage > 0.85) continue;
          let duplicate = false;
          for (const previous of candidates) {
            let union = 0, intersection = 0;
            for (let p = 0; p < mask.length; p++) {
              if (mask[p] || previous.mask[p]) union++;
              if (mask[p] && previous.mask[p]) intersection++;
            }
            if (intersection / Math.max(1, union) > 0.9) {
              duplicate = true;
              if (score > previous.score) {
                previous.mask = mask;
                previous.score = score;
                previous.area = area;
              }
              break;
            }
          }
          if (!duplicate) candidates.push({ mask, score, area });
        }
        for (const tensor of Object.values(result)) tensor.dispose?.();
      }
      candidates.sort((a, b) => b.score - a.score);
      const kept = candidates.slice(0, 1), remaining = candidates.slice(1);
      while (remaining.length && kept.length < 24) {
        let best = 0, bestDistance = -1;
        for (let c = 0; c < remaining.length; c++) {
          let distance = 1;
          for (const previous of kept) {
            let union = 0, intersection = 0;
            for (let p = 0; p < previous.mask.length; p++) {
              if (previous.mask[p] || remaining[c].mask[p]) union++;
              if (previous.mask[p] && remaining[c].mask[p]) intersection++;
            }
            distance = Math.min(distance, 1 - intersection / Math.max(1, union));
          }
          if (distance > bestDistance) {
            bestDistance = distance;
            best = c;
          }
        }
        kept.push(remaining.splice(best, 1)[0]);
      }
      if (!kept.length) throw new Error("segmentation-unavailable");
      for (let choice = 0; choice < kept.length; choice++) outputs.push({ id: job.id, choice, mask: kept[choice].mask, width: w / 4, height: h / 4 });
      for (const tensor of Object.values(embeddings)) tensor.dispose?.();
    }
    worker.postMessage({ ok: true, outputs }, outputs.map((o) => o.mask.buffer));
  } catch (error) {
    console.warn("Local segmentation failed:", error instanceof Error ? error.message : "unknown");
    worker.postMessage({ ok: false });
  } finally {
    await encoder?.release().catch(() => {
    });
    await decoder?.release().catch(() => {
    });
    for (const url of urls) URL.revokeObjectURL(url);
  }
};
