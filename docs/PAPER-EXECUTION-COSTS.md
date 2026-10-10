# Paper Execution Cost Model

Trading Nova's market-order simulator deliberately models costs instead of filling at the displayed last-traded price for free.

## Defaults

- **Reference mark:** the fresh last-traded price, used to mark open positions.
- **BUY execution:** current ask plus configured slippage.
- **SELL execution:** current bid minus configured slippage.
- **Fee:** charged on executed notional for every fill (buy and sell).
- **Default fee rate:** `0.001` (0.10% per fill).
- **Default additional slippage:** `5` basis points (0.05%) beyond the quoted bid/ask.
- **Spread:** the spread is represented by crossing to the ask on a buy or the bid on a sell. The fill records the quote, measured spread, slippage and fee separately.

These assumptions are deterministic estimates for paper research; they are not claimed to match a particular exchange's fee tier, market impact, latency or actual execution. Actual quote freshness is still mandatory. A missing, invalid or crossed bid/ask quote rejects the paper order rather than silently substituting the last price.

## Configuration

Set the following server environment variables before starting the server:

- `NOVA_PAPER_FEE_RATE`: decimal rate, e.g. `0.001` means 0.10% per fill.
- `NOVA_PAPER_SLIPPAGE_BPS`: non-negative integer basis points, e.g. `5` means 0.05%.

Supported bounds are fee rate 0–5% and slippage 0–1,000 bps. Invalid or empty configured values stop server creation instead of silently disabling costs. Defaults apply when variables are absent. These settings affect paper fills only and cannot enable real-money execution.

Each persisted fill records its execution price, reference mark, quote bid/ask, spread estimate, slippage assumption, fee rate and fee amount. Buy affordability checks include the fee before execution. Portfolio cash pays the fee immediately, while open positions are marked at the reference last-traded price. Idempotent replay returns the stored fill and the original cost record.

## Not yet modelled

Partial fills, order-book depth/market impact, exchange-specific fee schedules, network latency, cancel/replace lifecycle and venue-specific reject probabilities are separate follow-up tasks. Until pending-order state and those lifecycle tests exist, LIMIT, STOP_LOSS and TAKE_PROFIT remain explicitly unsupported and rejected.
