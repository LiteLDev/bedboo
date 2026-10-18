// owner: U3 (parity tooling)
'use strict'
/**
 * Declaration surface of a mineflayer-style index.d.ts, read with the TypeScript compiler.
 *
 * typescript 7 (the devDependency) is the native compiler; its JS API (`typescript/unstable/sync`)
 * talks to the bundled `tsc` binary and returns real syntax trees, so nothing here pattern-matches
 * source text. Only syntax is used (no type checking), so dependency typings need not resolve.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

let ts = null
function loadTs () {
  if (!ts) {
    ts = {
      ...require('typescript/unstable/sync'),
      SyntaxKind: require('typescript/unstable/ast').SyntaxKind
    }
  }
  return ts
}

function nameOf (node) {
  if (!node || !node.name) return null
  return node.name.text ?? node.name.escapedText ?? null
}

/** Function-like signature info of a type node (function type, or an intersection/union of them). */
function signatureOf (typeNode) {
  const { SyntaxKind: K } = loadTs()
  if (!typeNode) return null
  switch (typeNode.kind) {
    case K.ParenthesizedType:
      return signatureOf(typeNode.type)
    case K.FunctionType:
      return {
        params: typeNode.parameters.length,
        required: typeNode.parameters.filter(p => !p.questionToken && !p.initializer && !p.dotDotDotToken).length,
        rest: typeNode.parameters.some(p => p.dotDotDotToken),
        returnsPromise: returnsPromise(typeNode.type)
      }
    case K.IntersectionType:
    case K.UnionType: {
      const sigs = typeNode.types.map(signatureOf).filter(Boolean)
      if (sigs.length === 0) return null
      return {
        params: Math.max(...sigs.map(s => s.params)),
        required: Math.min(...sigs.map(s => s.required)),
        rest: sigs.some(s => s.rest),
        returnsPromise: sigs.every(s => s.returnsPromise)
      }
    }
    default:
      return null
  }
}

function returnsPromise (typeNode) {
  const { SyntaxKind: K } = loadTs()
  if (!typeNode) return false
  if (typeNode.kind === K.TypeReference) return typeNode.typeName && typeNode.typeName.text === 'Promise'
  if (typeNode.kind === K.UnionType) return typeNode.types.every(returnsPromise)
  return false
}

/** Members of an interface/class body → [{ name, kind: 'method'|'property', params?, required?, returnsPromise?, optional }] */
function membersOf (node) {
  const { SyntaxKind: K } = loadTs()
  const out = []
  for (const m of node.members || []) {
    const name = nameOf(m)
    if (name == null) continue // index signatures, constructors, call signatures
    if (m.kind === K.MethodSignature || m.kind === K.MethodDeclaration) {
      out.push({
        name,
        kind: 'method',
        params: m.parameters.length,
        required: m.parameters.filter(p => !p.questionToken && !p.initializer && !p.dotDotDotToken).length,
        returnsPromise: returnsPromise(m.type),
        static: (m.modifiers || []).some(x => x.kind === K.StaticKeyword),
        optional: !!m.questionToken
      })
    } else if (m.kind === K.PropertySignature || m.kind === K.PropertyDeclaration) {
      const sig = signatureOf(m.type)
      if (sig) {
        out.push({ name, kind: 'method', ...sig, optional: !!m.questionToken })
      } else {
        out.push({ name, kind: 'property', optional: !!m.questionToken, typeText: typeText(m.type) })
      }
    }
  }
  return out
}

/** Short text form of simple type nodes ('number', 'Vec3', 'Item | null', …); null when complex. */
function typeText (typeNode) {
  const { SyntaxKind: K } = loadTs()
  if (!typeNode) return null
  switch (typeNode.kind) {
    case K.NumberKeyword: return 'number'
    case K.StringKeyword: return 'string'
    case K.BooleanKeyword: return 'boolean'
    case K.AnyKeyword: return 'any'
    case K.TypeReference: return typeNode.typeName.text ?? null
    case K.LiteralType: return typeNode.literal.kind === K.NullKeyword ? 'null' : null
    case K.UnionType: {
      const parts = typeNode.types.map(typeText)
      return parts.includes(null) ? null : parts.join(' | ')
    }
    default: return null
  }
}

/**
 * @param {string} file path of an index.d.ts
 * @returns {{
 *   functions: string[], classes: Record<string, { members: object[], extends: string|null, typeArg: string|null }>,
 *   interfaces: Record<string, { members: object[], extends: string[] }>, variables: string[], types: string[],
 *   declarations: string[]
 * }}
 */
function readDts (file) {
  const { API, SyntaxKind: K } = loadTs()
  // Parse a private copy so a sibling tsconfig.json (if any) cannot change how it is read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedboo-dts-'))
  const api = new API({ cwd: dir })
  try {
    const copy = path.join(dir, 'index.d.ts')
    fs.copyFileSync(file, copy)
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, types: [], skipLibCheck: true },
      files: ['index.d.ts']
    }))
    const snapshot = api.updateSnapshot({ openProject: path.join(dir, 'tsconfig.json') })
    const project = snapshot.getProjects()[0]
    const sf = project && project.program.getSourceFile(copy)
    if (!sf) throw new Error(`typescript could not parse ${file}`)

    const out = { functions: [], classes: {}, interfaces: {}, variables: [], types: [], declarations: [] }
    for (const st of sf.statements) {
      const name = nameOf(st)
      switch (st.kind) {
        case K.FunctionDeclaration:
          if (!out.functions.includes(name)) out.functions.push(name)
          break
        case K.ClassDeclaration: {
          const ext = (st.heritageClauses || []).flatMap(h => h.types)[0]
          out.classes[name] = {
            members: membersOf(st),
            extends: ext ? ext.expression.text : null,
            typeArg: ext && ext.typeArguments && ext.typeArguments[0] ? typeText(ext.typeArguments[0]) : null
          }
          break
        }
        case K.InterfaceDeclaration:
          out.interfaces[name] = {
            members: membersOf(st),
            extends: (st.heritageClauses || []).flatMap(h => h.types).map(t => t.expression.text)
          }
          break
        case K.TypeAliasDeclaration:
          out.types.push(name)
          break
        case K.VariableStatement:
          for (const d of st.declarationList.declarations) out.variables.push(d.name.text)
          break
        default:
          continue
      }
    }
    out.declarations = [...new Set([...out.functions, ...Object.keys(out.classes), ...Object.keys(out.interfaces), ...out.types, ...out.variables])]
    return out
  } finally {
    api.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { readDts }
