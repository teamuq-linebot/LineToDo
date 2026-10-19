export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'better-sqlite3' || specifier === 'better-sqlite3-multiple-ciphers') {
    return nextResolve(new URL('./sqlite-test-adapter.mjs', import.meta.url).href, context)
  }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(ts|js|mjs|cjs|json)$/i.test(specifier)) {
      try {
        return await nextResolve(`${specifier}.ts`, context)
      } catch {
        // a directory import (e.g. '../llm/provider'): resolve its index.ts like the bundlers do
        return nextResolve(`${specifier.replace(/\/$/, '')}/index.ts`, context)
      }
    }
    throw error
  }
}
