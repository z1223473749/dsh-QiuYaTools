import { zipSync, strToU8 } from 'fflate'

const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))))
/** Small real OOXML documents; no fixture is a renamed text file. */
export function wordPreviewFixture() {
  const paragraphs = [
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>功能反馈与改进建议</w:t></w:r></w:p>',
    ...['一、文件附件预览', '从其他应用拖入文件后，在输入区展示实际内容。', '图片直接显示缩略图，文档显示页面内容。', '二、兼容范围', 'Windows 与 macOS 使用相同的附件卡片。', '支持文本、Word、Excel、PDF 和其他附件。', '三、交互方式', '点击卡片放大预览，按 Escape 关闭。', '已有输入内容保留，文件不会自动发送。', '四、验证结果', '文件内容保持完整，上传失败可以单独重试。', '长文本生成的 TXT 同样显示内容缩略图。'].map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`),
  ].join('')
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
  })
}

export function spreadsheetPreviewFixture() {
  const values = [['项目', '负责人', '数量', '状态'], ['图片预览', '秋雅', '12', '完成'], ['文档内容', '研发', '8', '完成'], ['表格缩略图', '测试', '5', '验证中'], ['PDF 首页', '研发', '3', '完成'], ['Windows', '测试', '10', '检查中'], ['macOS', '测试', '10', '完成'], ['总计', '', '48', '']]
  const rows = values.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/overview.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="汇总回执" sheetId="3" r:id="first"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/overview.xml"/></Relationships>',
    'xl/worksheets/overview.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
  })
}

export function pdfPreviewFixture() {
  const stream = '0.12 0.35 0.6 rg 40 690 515 100 re f\n1 1 1 rg BT /F1 24 Tf 58 745 Td (Attachment Preview) Tj ET\n0.15 0.2 0.25 rg BT /F1 14 Tf 44 655 Td (Actual PDF first-page content) Tj 0 -28 Td (Local rendering - no upload for preview) Tj ET\n' + Array.from({ length: 12 }, (_, i) => `0.65 0.75 0.82 RG 44 ${590 - i * 25} m 550 ${590 - i * 25} l S\nBT /F1 10 Tf 50 ${598 - i * 25} Td (Project item ${i + 1} - ready for review) Tj ET`).join('\n')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let source = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const offset = Buffer.byteLength(source)
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  return Buffer.from(source)
}
