#!/bin/sh
# Imports the keeper key (KEEPER_PRIV, a Render secret) into a throwaway cast keystore so that it is not on the command line of every
# send, then runs the keeper with it. Everything else is the keeper's own environment (see tools/tac-vault-keeper.mjs).
set -eu
: "${KEEPER_PRIV:?set KEEPER_PRIV (secret)}"
: "${RPC:?set RPC (an archive endpoint: eth_getProof for blocks up to 8 hours old)}"
umask 077
PW="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$PW" > /tmp/keeper.pw
cast wallet import keeper --private-key "$KEEPER_PRIV" --keystore-dir "$HOME/.foundry/keystores" --unsafe-password "$PW" >/dev/null
unset KEEPER_PRIV PW
export KEEPER_ACCOUNT=keeper KEEPER_PASSWORD_FILE=/tmp/keeper.pw
exec node tools/tac-vault-keeper.mjs
