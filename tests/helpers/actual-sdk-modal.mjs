/** Compile the real public SDK Modal and its exact declaration closure; do not stub its portal, layers or focus logic. */
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url), ts = require('typescript')
export async function prepareActualSDKModal() {
  const entry = require.resolve('@deepseek-ai/dsh-client-ui-primitives'), source = await readFile(entry, 'utf8'), parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), declared = new Map(), chosen = new Set()
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause; if (clause?.name) declared.set(clause.name.text, statement)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) declared.set(item.name.text, statement)
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) declared.set(clause.namedBindings.name.text, statement)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.set(statement.name.text, statement)
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declared.set(declaration.name.text, statement)
  }
  const visit = name => {
    const statement = declared.get(name); if (!statement || chosen.has(statement)) return
    chosen.add(statement)
    if (ts.isImportDeclaration(statement)) return
    const walk = node => { if (ts.isIdentifier(node)) visit(node.text); ts.forEachChild(node, walk) }; walk(statement)
  }
  visit('Modal')
  if (![...chosen].some(s => ts.isFunctionDeclaration(s) && s.name?.text === 'Modal') || ![...chosen].some(s => ts.isFunctionDeclaration(s) && s.name?.text === 'useModalLayer')) throw Error('Actual public SDK Modal closure missing')
  const declarations = parsed.statements.filter(s => chosen.has(s)).map(statement => {
    const original = statement.getText(parsed)
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.startsWith('.')) return original
    const target = resolve(dirname(entry), statement.moduleSpecifier.text)
    return original.slice(0, statement.moduleSpecifier.getStart(parsed) - statement.getStart(parsed)) + JSON.stringify(target) + original.slice(statement.moduleSpecifier.getEnd() - statement.getStart(parsed))
  })
  const directory = await mkdtemp('/private/tmp/qiuya-real-sdk-modal-'), modulePath = join(directory, 'actual-modal.mjs'), closure = declarations.join('\n') + '\nexport { Modal };\n'
  await writeFile(modulePath, closure)
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ SDKEntry: entry, sourceSHA256: createHash('sha256').update(source).digest('hex'), closureSHA256: createHash('sha256').update(closure).digest('hex'), declarations: declarations.length, unmodifiedFunctionBodies: true, actualHost: 0, actualBrowser: 0, actualGUI: 0 }, null, 2) + '\n')
  return modulePath
}
