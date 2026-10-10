export function credentialsFromEnvironment(env = process.env) {
  if (Boolean(env.ASSINAFY_API_KEY) === Boolean(env.ASSINAFY_ACCESS_TOKEN)) throw new Error('Set exactly one of ASSINAFY_API_KEY or ASSINAFY_ACCESS_TOKEN.');
  if (!env.ASSINAFY_ACCOUNT_ID) throw new Error('Set ASSINAFY_ACCOUNT_ID to the test workspace ID.');
  if (!['production', 'sandbox'].includes(env.ASSINAFY_ENVIRONMENT)) throw new Error('Set ASSINAFY_ENVIRONMENT explicitly to production or sandbox.');
  return { ...(env.ASSINAFY_API_KEY ? { type: 'api_key', apiKey: env.ASSINAFY_API_KEY } : { type: 'oauth2', accessToken: env.ASSINAFY_ACCESS_TOKEN }),
    accountId: env.ASSINAFY_ACCOUNT_ID, environment: env.ASSINAFY_ENVIRONMENT };
}
