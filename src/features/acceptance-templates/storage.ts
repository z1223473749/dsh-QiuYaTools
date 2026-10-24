import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON, digest, object, RunError, uuid } from '../acceptance-runs/contract.ts';
import { fail } from '../acceptance-workflows/contract.ts';
import { parseTemplateRecord } from './contract.ts';
import type { TemplateRecord } from './contract.ts';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nofollow = constants.O_NOFOLLOW ?? 0;
interface FileIdentity {
    dev: bigint;
    ino: bigint;
}
interface StoreLimits {
    maxFileBytes: number;
    maxFiles: number;
    maxBytes: number;
    maxTemplates: number;
}
export interface TemplateStoreOptions {
    profileDirectory: string;
    limits?: Partial<StoreLimits>;
    fault?: (phase: 'beforeWrite' | 'beforeRename' | 'afterRename') => void;
}
/** A private profile directory is the trust boundary. No arbitrary path API or automatic stale-lock deletion. */
export class TemplateStore {
    readonly limits: StoreLimits;
    #options: TemplateStoreOptions;
    #root = '';
    #profile = '';
    #dirs = new Map<string, FileIdentity>();
    #initialization?: Promise<void>;
    constructor(options: TemplateStoreOptions) {
        this.#options = options;
        this.limits = { maxFileBytes: 512 * 1024, maxFiles: 256, maxBytes: 8 * 1024 * 1024, maxTemplates: 32, ...options.limits };
        for (const v of Object.values(this.limits))
            if (!Number.isSafeInteger(v) || v < 1)
                fail('INVALID_STORE_LIMIT');
    }
    async #init(): Promise<void> {
        return this.#initialization ??= (async () => {
            const input = resolve(this.#options.profileDirectory), stat = await lstat(input, { bigint: true });
            if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 18n) !== 0n))
                fail('UNSAFE_STORE_DIRECTORY');
            this.#profile = await realpath(input);
            if (this.#profile !== input)
                fail('UNSAFE_STORE_DIRECTORY');
            this.#dirs.set(input, { dev: stat.dev, ino: stat.ino });
            let current = input;
            for (const part of ['qiuya-tools-acceptance-templates', 'v1']) {
                current = join(current, part);
                try {
                    await mkdir(current, { mode: 0o700 });
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                        throw error;
                }
                ;
                const s = await lstat(current, { bigint: true });
                if (s.isSymbolicLink() || !s.isDirectory() || (process.platform !== 'win32' && (s.mode & 18n) !== 0n) || await realpath(current) !== current)
                    fail('UNSAFE_STORE_DIRECTORY');
                if (typeof process.getuid === 'function' && s.uid !== BigInt(process.getuid()))
                    fail('UNSAFE_STORE_DIRECTORY');
                this.#dirs.set(current, { dev: s.dev, ino: s.ino });
            }
            this.#root = current;
            await this.#guardDirectories();
        })();
    }
    async #guardDirectories(): Promise<void> {
        for (const [path, pin] of this.#dirs) {
            const s = await lstat(path, { bigint: true });
            if (s.isSymbolicLink() || !s.isDirectory() || (process.platform !== 'win32' && (s.mode & 18n) !== 0n) || s.dev !== pin.dev || s.ino !== pin.ino || await realpath(path) !== path)
                fail('STORE_DIRECTORY_CHANGED');
        }
    }
    #path(kind: 'template' | 'tmp' | 'lock', id: string): string { return join(this.#root, kind + '-' + uuid(id) + (kind === 'lock' ? '.lock' : '.json')); }
    async #inventory(extraBytes = 0, extraFiles = 0): Promise<string[]> {
        await this.#guardDirectories();
        const names = await readdir(this.#root);
        if (names.length + extraFiles > this.limits.maxFiles)
            fail('STORE_LIMIT');
        let bytes = extraBytes, runs = 0;
        for (const name of names) {
            if (!/^(?:template|tmp|lock)-[a-f0-9-]{36}\.(?:json|lock)$/u.test(name))
                fail('UNRECOGNIZED_STORE_ENTRY');
            const s = await lstat(join(this.#root, name), { bigint: true });
            if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1n)
                fail('UNSAFE_STORE_FILE');
            if (s.size > BigInt(this.limits.maxBytes))
                fail('STORE_LIMIT');
            bytes += Number(s.size);
            if (name.startsWith('template-'))
                runs++;
        }
        if (bytes > this.limits.maxBytes || runs > this.limits.maxTemplates)
            fail('STORE_LIMIT');
        return names;
    }
    async #read(path: string): Promise<TemplateRecord | undefined> {
        await this.#guardDirectories();
        let pathPin;
        try {
            pathPin = await lstat(path, { bigint: true });
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return;
            throw new RunError('UNSAFE_STORE_FILE');
        }
        // Windows has no O_NOFOLLOW. Reject symlinks, directories and special files
        // before open, then compare the opened object before reading any bytes.
        if (pathPin.isSymbolicLink() || !pathPin.isFile() || pathPin.nlink !== 1n || pathPin.size > BigInt(this.limits.maxFileBytes))
            fail('UNSAFE_STORE_FILE');
        let handle: FileHandle;
        try {
            handle = await open(path, constants.O_RDONLY | nofollow);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return;
            throw new RunError('UNSAFE_STORE_FILE');
        }
        try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(this.limits.maxFileBytes) || before.dev !== pathPin.dev || before.ino !== pathPin.ino)
                fail('UNSAFE_STORE_FILE');
            const buffer = Buffer.alloc(this.limits.maxFileBytes + 1);
            let count = 0;
            while (count < buffer.length) {
                const r = await handle.read(buffer, count, buffer.length - count, count);
                if (!r.bytesRead)
                    break;
                count += r.bytesRead;
            }
            if (count > this.limits.maxFileBytes)
                fail('STORE_LIMIT');
            const after = await handle.stat({ bigint: true }), entry = await lstat(path, { bigint: true });
            if (after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(count) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || entry.isSymbolicLink() || entry.dev !== before.dev || entry.ino !== before.ino)
                fail('STORE_FILE_CHANGED');
            const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
            const envelope = object(decoded, ['record', 'sha256']);
            if (digest(envelope.sha256) !== hash(canonicalJSON(envelope.record)))
                fail('STORE_INTEGRITY');
            const record = parseTemplateRecord(envelope.record);
            if (record.versions.some(version => version.planSHA256 !== hash(canonicalJSON(version.plan))))
                fail('STORE_INTEGRITY');
            await this.#guardDirectories();
            return record;
        }
        catch (error) {
            if (error instanceof RunError)
                throw error;
            throw new RunError('CORRUPT_STORE');
        }
        finally {
            await handle.close();
        }
    }
    async load(templateId: string): Promise<TemplateRecord | undefined> {
        await this.#init();
        const r = await this.#read(this.#path('template', templateId));
        if (r && r.templateId !== templateId)
            fail('STORE_BINDING_MISMATCH');
        return r;
    }
    async list(): Promise<TemplateRecord[]> {
        await this.#init();
        const names = await this.#inventory();
        const records: TemplateRecord[] = [];
        for (const name of names.filter(x => x.startsWith('template-')).sort()) {
            const id = name.slice(9, -5);
            const r = await this.load(id);
            if (r)
                records.push(r);
        }
        return records;
    }
    async #create(path: string, bytes: string): Promise<FileIdentity> {
        await this.#guardDirectories();
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
        try {
            const pin = await handle.stat({ bigint: true });
            if (!pin.isFile() || pin.nlink !== 1n)
                fail('UNSAFE_STORE_FILE');
            await handle.writeFile(bytes, 'utf8');
            await handle.sync();
            const after = await handle.stat({ bigint: true });
            if (after.dev !== pin.dev || after.ino !== pin.ino || after.nlink !== 1n || after.size !== BigInt(Buffer.byteLength(bytes)))
                fail('STORE_FILE_CHANGED');
            return { dev: pin.dev, ino: pin.ino };
        }
        finally {
            await handle.close();
        }
    }
    async #unlinkOwned(path: string, pin: FileIdentity): Promise<void> {
        const now = await lstat(path, { bigint: true });
        if (now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino || !now.isFile() || now.nlink !== 1n)
            fail('STORE_FILE_CHANGED');
        await unlink(path);
    }
    /** Exact revision lock, bounded private file, then atomic head rename. Unknown commits never replay execution. */
    async compareAndSwap(value: TemplateRecord, expectedRevision: number, guard: () => void): Promise<TemplateRecord> {
        await this.#init();
        const record = parseTemplateRecord(value);
        if (record.versions.some(version => version.planSHA256 !== hash(canonicalJSON(version.plan))))
            fail('STORE_INTEGRITY');
        if (record.revision !== expectedRevision + 1)
            fail('REVISION_CONFLICT');
        const serialized = canonicalJSON({ record, sha256: hash(canonicalJSON(record)) });
        if (Buffer.byteLength(serialized) > this.limits.maxFileBytes)
            fail('STORE_LIMIT');
        const lockPath = this.#path('lock', record.templateId);
        let lock: FileIdentity;
        try {
            lock = await this.#create(lockPath, randomUUID());
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                throw new RunError('STORE_BUSY');
            throw error;
        }
        let temporary: string | undefined, pin: FileIdentity | undefined;
        try {
            guard();
            const current = await this.load(record.templateId);
            if ((current?.revision ?? 0) !== expectedRevision)
                fail('REVISION_CONFLICT');
            if (current) {
                if (current.revokedAt !== null)
                    fail('TEMPLATE_REVOKED');
                if (record.createdAt !== current.createdAt || record.versions.length < current.versions.length || record.executions.length < current.executions.length || current.versions.some((version, index) => canonicalJSON(version) !== canonicalJSON(record.versions[index])) || current.executions.some((execution, index) => canonicalJSON(execution) !== canonicalJSON(record.executions[index])))
                    fail('TEMPLATE_IMMUTABLE');
            }
            if (!current && (await this.list()).length >= this.limits.maxTemplates)
                fail('STORE_LIMIT');
            await this.#inventory(Buffer.byteLength(serialized), 1);
            this.#options.fault?.('beforeWrite');
            temporary = this.#path('tmp', randomUUID());
            pin = await this.#create(temporary, serialized);
            await this.#guardDirectories();
            this.#options.fault?.('beforeRename');
            await this.#guardDirectories();
            guard();
            await rename(temporary, this.#path('template', record.templateId));
            temporary = undefined;
            pin = undefined;
            await this.#guardDirectories();
            this.#options.fault?.('afterRename');
            return structuredClone(record);
        }
        catch (error) {
            if (error instanceof RunError)
                throw error;
            throw new RunError('STORE_COMMIT_UNCONFIRMED');
        }
        finally {
            if (temporary && pin)
                await this.#unlinkOwned(temporary, pin);
            await this.#unlinkOwned(lockPath, lock);
        }
    }
}
