export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'better-sqlite3' || specifier === 'better-sqlite3-multiple-ciphers') {
    return nextResolve(new URL('./sqlite-test-adapter.mjs', import.meta.url).href, context)
  }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.(ts|js|mjs|cjs|json)$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}
