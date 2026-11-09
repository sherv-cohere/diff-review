import { codeToTokens, isSupportedLanguage, type ThemedToken } from '@pierre/highlights'
import theme from '@pierre/highlights/themes/github-dark-default'

export type { ThemedToken }

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'jsx', mjs: 'jsx', cjs: 'jsx', jsx: 'jsx',
  go: 'go', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  py: 'python', rs: 'rust', css: 'css', sql: 'sql', toml: 'toml', proto: 'proto',
  mk: 'make', hcl: 'hcl', tf: 'hcl', ini: 'ini', cfg: 'ini', conf: 'ini',
  graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
  java: 'java', c: 'c', h: 'c', xml: 'xml', svg: 'xml',
}

const BY_NAME: Record<string, string> = { Dockerfile: 'dockerfile', Makefile: 'make', Tiltfile: 'python' }

export function languageFor(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : ''

  return BY_NAME[name] ?? (name.endsWith('.Dockerfile') ? 'dockerfile' : BY_EXTENSION[extension.toLowerCase()])
}

/** One themed token list per line, or undefined for a language the highlighter has no lexer for. */
export function tokenize(lines: string[], language: string | undefined): ThemedToken[][] | undefined {
  if (language === undefined || !isSupportedLanguage(language) || lines.length === 0) return undefined

  return codeToTokens(lines.join('\n'), { lang: language, theme }).tokens
}
