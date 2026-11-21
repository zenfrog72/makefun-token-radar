// farm.ts — the farm engine: for every ranked protocol, a concrete plan with priced steps, and a
// verdict that nets the modelled drop against the plan's own fees and a 4% T-bill on the same
// money. Everything is derived from the protocol's own record — its category, its primary chain,
// its TVL and its last week's move — never from a hand-written list of names.

import type { SnapshotProtocol } from './snapshot.ts';
import { familyOf } from './snapshot.ts';

export interface Scenario {
  deposit: number;
  dropShare: number;
  horizonWeeks: number;
}

export const DEFAULT_SCENARIO: Scenario = { deposit: 10_000, dropShare: 0.07, horizonWeeks: 12 };
export const TBILL_ANNUAL = 0.04;
/** A farm must clear this net per hands-on hour, on top of the T-bill, to earn a FARM verdict. */
export const FARM_HOUR_LINE = 25;
/** The plan never takes more than this share of a protocol's TVL: size must not move the pool. */
export const PLAN_TVL_SHARE = 0.0002;

/** One simple transaction's gas, in dollars, on the chains the snapshot names most. */
const GAS_USD: Record<string, number> = {
  Ethereum: 4.5, Bitcoin: 1.2, Tron: 1.1, Avalanche: 0.25, Binance: 0.15, Arbitrum: 0.08,
  Base: 0.05, Linea: 0.05, Scroll: 0.05, 'zkSync Era': 0.05, Optimism: 0.05, Plasma: 0.05,
  Cosmos: 0.05, Cronos: 0.05, Moonbeam: 0.05, Boba: 0.05, Solana: 0.02, Monad: 0.02,
  Ink: 0.03, Mantle: 0.02, Fraxtal: 0.02, Mode: 0.02, Blast: 0.02, Sonic: 0.01,
  Polygon: 0.01, 'Hyperliquid L1': 0.01, Stellar: 0.01, Sui: 0.01, Aptos: 0.01, Near: 0.01,
  Fantom: 0.01, Celo: 0.01, Gnosis: 0.01, Aurora: 0.01, Berachain: 0.02, Taiko: 0.05,
  Unichain: 0.02, 'World Chain': 0.02, Abstract: 0.02, Eclipse: 0.02, 'X Layer': 0.02,
  Katana: 0.02, Pharos: 0.02, Flare: 0.02, Sei: 0.01, Metis: 0.05, 'OP Mainnet': 0.05,
};
const GAS_DEFAULT = 0.3;
/** One exchange withdrawal, charged twice in a plan: the gas token, then the USDC. */
const WITHDRAWAL_USD = 1;

export function gasFor(chain: string): number {
  return GAS_USD[chain] ?? GAS_DEFAULT;
}

export function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
}

/** The plan's size under a scenario: the deposit, capped at 0.02% of TVL, floored at $250. */
export function planSize(tvlUsd: number, scenario: Scenario): number {
  return Math.max(250, Math.min(scenario.deposit, Math.floor(PLAN_TVL_SHARE * tvlUsd)));
}

export interface FarmMath {
  plan: number;
  feesFixed: number;
  feesPerWeek: number;
  fees: number;
  drop: number;
  net: number;
  hours: number;
  netHour: number;
  tbill: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
}

/** The whole scenario arithmetic for one protocol, shared by board.json and the dashboard. */
export function farmMath(tvlUsd: number, impliedUsd: number, gasUsd: number, scenario: Scenario): FarmMath {
  const plan = planSize(tvlUsd, scenario);
  const feesFixed = 2 * WITHDRAWAL_USD + 7 * gasUsd; // two withdrawals; core (3) + deepen (2) + exit (2) transactions
  const feesPerWeek = gasUsd; // one cadence transaction a week; the weekly watch is a read, not a transaction
  const fees = feesFixed + feesPerWeek * scenario.horizonWeeks;
  const drop = (impliedUsd * scenario.dropShare * plan) / (tvlUsd + plan);
  const net = drop - fees;
  const hours = (70 + 10 * scenario.horizonWeeks) / 60;
  const tbill = plan * TBILL_ANNUAL * (scenario.horizonWeeks / 52);
  const verdict: FarmMath['verdict'] = net <= 0 ? 'SKIP' : net >= tbill && net / hours >= FARM_HOUR_LINE ? 'FARM' : 'MARGINAL';
  return { plan, feesFixed, feesPerWeek, fees, drop, net, hours, netHour: net / hours, tbill, verdict };
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const money2 = (n: number): string => `$${n.toFixed(2)}`;

/** The category's core action, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, plan: number, chain: string): string {
  const c = p.category ?? '';
  const fam = familyOf(c);
  const amt = money(plan);
  if (c === 'Lending' || c === 'CDP') return `Supply ${amt} of USDC to ${p.name} on ${chain} as collateral and, if the app offers points for it, open one small borrow against it and repay it within the first week.`;
  if (c === 'Dexs') return `Provide ${amt} of liquidity to ${p.name}'s deepest stablecoin pool on ${chain}, in range, and leave the position untouched between weekly touches.`;
  if (fam === 'Yield & vaults') return `Deposit ${amt} of USDC (or the asset the strategy names) into ${p.name}'s main vault on ${chain}. Note whether it auto-compounds and whether its receipt token earns points when held or used elsewhere. Start with a $100 test, then size up to the full ${amt}.`;
  if (fam === 'Trading') return `Deposit ${amt} of USDC as margin or vault capital on ${p.name} (${chain}) and run one small hedged position a week so the account shows real use, not a parked balance.`;
  if (fam === 'Staking') return `Stake ${amt} of the chain's staking asset through ${p.name} on ${chain} and keep the liquid receipt token in the same wallet for the whole horizon.`;
  if (fam === 'Chains & bridges') return `Bridge ${amt} of USDC to ${chain} through ${p.name} and put the bridged funds to work in one app on the far side, so both the crossing and the activity count.`;
  if (fam === 'RWA & stable') return `Mint or deposit ${amt} of the protocol's yield asset through ${p.name} on ${chain} and hold it; set a calendar note for any lock-up or redemption window.`;
  if (c === 'Chain') return `Fund the wallet on ${p.name} with ${amt} and make the chain itself the farm: one swap, one contract deployment or name registration, and one bridge in or out across the horizon.`;
  return `Deposit ${amt} of USDC into ${p.name} on ${chain} through its main app and keep the position open for the whole horizon.`;
}

/** The category's named risk, read before any money moves. */
function riskRead(p: SnapshotProtocol): string {
  const c = p.category ?? '';
  const fam = familyOf(c);
  if (fam === 'Yield & vaults') return `Strategy risk: a vault stacks other protocols beneath it, so any of them can fail. Read ${p.name}'s strategy page and avoid vaults whose yield is mostly paid in an unlisted points token.`;
  if (c === 'Lending' || c === 'CDP') return `Liquidation risk: read ${p.name}'s collateral factors before borrowing. Keep any borrow under a third of the supplied value so an ordinary bad week cannot liquidate the position.`;
  if (c === 'Dexs') return `Impermanent-loss risk: a volatile pair can cost more than the drop is worth. Prefer ${p.name}'s stablecoin pools, and check the pool's own fee income covers its recent range moves.`;
  if (fam === 'Trading') return `Venue risk: margin on ${p.name} is a claim on the venue, not on the chain. Keep the position small, hedge it, and withdraw profits to the wallet weekly rather than letting them ride.`;
  if (fam === 'Staking') return `Slashing and lock-up risk: read ${p.name}'s unbonding period and slashing record first. If the exit queue is longer than the horizon, the position cannot be unwound in time.`;
  if (fam === 'Chains & bridges') return `Bridge risk: a bridge is the largest single point of failure in this plan. Cross with a test amount first, and never hold more on the far side than the plan needs.`;
  return `Contract risk: ${p.name} is unaudited until you find the audit. Read its docs' risk page, check the contracts it names against its app, and size the position as if the newest contract is the weakest link.`;
}

export interface FarmStep {
  tag: string;
  text: string;
  cost: string;
  time: string;
}

/** A step as board.json carries it: the action, then its cost and time, 20 to 600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s;
}

export interface FarmInput {
  p: SnapshotProtocol;
  tvlUsd: number;
  impliedUsd: number;
  change7d: number | null;
}

/** The full priced plan for one protocol under a scenario: ten steps, each with its cost and time. */
export function farmPlan(input: FarmInput, scenario: Scenario): { steps: FarmStep[]; math: FarmMath } {
  const { p } = input;
  const chain = primaryChain(p);
  const gas = gasFor(chain);
  const math = farmMath(input.tvlUsd, input.impliedUsd, gas, scenario);
  const plan = math.plan;
  const sharePct = ((plan / input.tvlUsd) * 100).toFixed(3);
  const weeks = scenario.horizonWeeks;
  const chg = input.change7d === null ? 0 : input.change7d;
  const exitPct = Math.min(40, Math.max(10, Math.round(2 * Math.abs(chg))));
  const exitTvl = Math.round(input.tvlUsd * (1 - exitPct / 100));
  const otherChain = p.chains.find((c) => c !== chain);
  const steps: FarmStep[] = [
    {
      tag: 'SETUP',
      text: `Set up an EVM wallet (a hardware-backed account is best) used only for this farm and withdraw about $5 of ${chain}'s gas token to it from an exchange.`,
      cost: `${money2(WITHDRAWAL_USD)} (one exchange withdrawal)`,
      time: '10 min hands-on',
    },
    {
      tag: 'VERIFY',
      text: `Reach ${p.name} from its DefiLlama page (defillama.com/protocol/${p.slug}) or its official accounts, bookmark the app and match the contract addresses against its docs. Never sign an approval from a link sent in a DM.`,
      cost: 'free',
      time: '5 min hands-on',
    },
    {
      tag: 'FUND',
      text: `Withdraw ${money(plan)} of USDC straight to ${chain} from an exchange that supports it, or move it from Ethereum with a large bridge that lists ${chain}.`,
      cost: `${money2(WITHDRAWAL_USD)} (exchange withdrawal fee)`,
      time: '10 min hands-on; wait 2-20 minutes to arrive',
    },
    {
      tag: 'RISK',
      text: riskRead(p),
      cost: 'free (reading only; the deposit is the capital at risk)',
      time: '10 min hands-on',
    },
    {
      tag: 'CORE',
      text: coreAction(p, plan, chain),
      cost: `${money2(3 * gas)} (3 transactions at about ${money2(gas)} on ${chain})`,
      time: '15 min hands-on',
    },
    {
      tag: 'DEEPEN',
      text: otherChain
        ? `Hold the receipt token, or post it where ${p.name} lists a points boost (a lending market or an LP), but never loop it more than once. A second deployment on ${otherChain} lets the same wallet show activity on more than one chain.`
        : `Hold the receipt token, or post it where ${p.name} lists a points boost (a lending market or an LP), but never loop it more than once: a second loop doubles the contracts that can fail for the same drop.`,
      cost: `${money2(2 * gas)} (2 transactions at about ${money2(gas)} on ${chain})`,
      time: '10 min hands-on',
    },
    {
      tag: 'CADENCE',
      text: `${p.name} has run with no token recorded. Touch the position once a week (a top-up, a claim, a vote) so the wallet shows steady use rather than one deposit.`,
      cost: `${money2(gas * weeks)} (1 transaction a week at about ${money2(gas)} on ${chain})`,
      time: `5 min a week for ${weeks} weeks hands-on`,
    },
    {
      tag: 'WATCH',
      text: `Exit rule, checked weekly: withdraw if TVL prints below ${money(exitTvl)}, which is -${exitPct}% from today's ${money(input.tvlUsd)} (its last week was ${chg > 0 ? '+' : ''}${chg.toFixed(1)}%); also if withdrawals are paused or the team says a snapshot has already been taken.`,
      cost: 'free',
      time: `5 min a week for ${weeks} weeks hands-on`,
    },
    {
      tag: 'EXIT',
      text: `At the horizon's end, or on a token announcement, claim only from the link ${p.name} itself publishes, then unwind the position in the reverse order it was built and bridge the proceeds back to the exchange chain.`,
      cost: `${money2(2 * gas)} (2 transactions at about ${money2(gas)} on ${chain})`,
      time: '15 min hands-on',
    },
    {
      tag: 'RECORD',
      text: `Keep a ledger from the first transaction: date, transaction hash, asset, amount and dollar value of the ${money(plan)}, of every top-up, claim and withdrawal. A claim may ask the wallet to prove its history, and a drop is taxable income in many places at its value on the day it arrives.`,
      cost: 'nothing but the log',
      time: '10 min hands-on',
    },
  ];
  return { steps, math };
}
