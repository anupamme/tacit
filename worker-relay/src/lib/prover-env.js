// The environment a spawned prover binary runs with: what the service has, less its keys, tokens and database URL. The binary needs the
// network key (set explicitly by the caller), the routing settings and the input mode, and nothing else the service holds.
const SECRET_NAME = /(?:^|_)(?:KEY|SK|SECRET|TOKEN|TOKENS|JWT|SEED|MNEMONIC|PASSWORD|PASS|PRIV)(?:_\d+)?$|^DATABASE_URL$/;

export function proverEnvFrom(processEnv, { sp1Prover, networkRpcUrl, proverOut, networkPrivateKey }, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(processEnv)) if (!SECRET_NAME.test(k)) env[k] = v;
  Object.assign(env, { SP1_PROVER: sp1Prover, NETWORK_RPC_URL: networkRpcUrl, PROVER_OUT: proverOut, ...extra });
  if (networkPrivateKey) env.NETWORK_PRIVATE_KEY = networkPrivateKey;
  return env;
}
