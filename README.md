# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/zenfrog72/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/zenfrog72/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot: a fitted model — an ln-TVL size curve plus shrunk family effects for value-if-it-launches, and a peer-outcome model for launch odds, every term kept only if it lowers the miss in both leave-one-out and walk-forward tests — prices 199 pre-token protocols (all 40 watchlist slugs included), prints P25–P75 ranges, and costs out a 10-step farm plan per row. The offline dashboard recomputes the whole board in the browser and prints the checksum proving it agrees with board.json. Node 22, standard library only, no network; two runs write byte-identical output.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pcjmcqh3&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
