# Hand-worked example (Vitest ground truth)

Tiny table, N = 10 rows. ICP pass rate = 40% (4 pass, 6 fail) when `ICP Pass` column is present. Filter is **late**.

## Waterfall with Clay refunds

Data Credits charge **only on hits**:

\[
E[\mathrm{DC}] = \sum_i \mathrm{price}_i \times P(\mathrm{reach\ } i) \times \mathrm{hit}_i
\]

Actions still charge **per attempt**:

\[
E[\mathrm{Actions}] = \sum_i \mathrm{actionCost} \times P(\mathrm{reach\ } i)
\]

With Findymail 0.5 @ 0.5, Prospeo 0.3 @ 0.4, Hunter 0.2 @ 0.25:

- \(E[\mathrm{DC}] = 0.325\)
- \(E[\mathrm{Actions}] = 1.8\) per row (if 1 Action per attempt)

## ICP from CSV

If `ICP Pass` is missing, pass rate is derived from a numeric rule (default: employee count column in `[50, 500]`). Uploads without `ICP Pass` no longer read as “100% fail.”

## Hit rates from CSV

Provider-win columns override declared JSON rates. Without a win column, rates scale to the email/field fill rate so uploads change the analysis.

## V1 limitations

- Independent hit-rate assumption across waterfall providers
- Providers overlap in practice; overlap isn't visible in a CSV export, so reorder savings are estimates
- $/Action and $/DC are inputs (plan-dependent)
