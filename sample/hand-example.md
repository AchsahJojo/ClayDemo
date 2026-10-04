# Hand-worked example (Vitest ground truth)

Tiny table, N = 10 rows. ICP pass rate = 40% (4 pass, 6 fail). Filter is **last**.

## Steps (wasteful order)

| # | Step | Type | Action | DC | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | find_contacts | enrich | 1 | 0.5 | all 10 rows |
| 2 | work_email | waterfall | 1 | E[cost] | Findymail 0.5 @ hit 0.5; Prospeo 0.3 @ 0.4; Hunter 0.2 @ 0.25 |
| 3 | validate_email | enrich | 1 | 0.1 | only rows with email; assume 70% of 10 = 7 |
| 4 | employee_count | enrich | 1 | 2.0 | all 10 (SMARTe) |
| 5 | emp_range | ai_formula | 0 | 0 | free |
| 6 | title_cleanup | use_ai | 1 | 0 | deterministic → R5 |
| 7 | icp_filter | filter | 0 | 0 | pass 0.4 |
| 8 | export | export | 1 | 0 | 4 ICP rows |

## Waterfall E[dataCredits] per row

```
E = 0.5
  + 0.3 × (1 − 0.5)
  + 0.2 × (1 − 0.5) × (1 − 0.4)
  = 0.5 + 0.15 + 0.06
  = 0.71
```

For 10 rows: waterfall DC = 7.1; waterfall Actions = 10.

## Baseline totals (before ICP pushdown)

- Actions = 10 + 10 + 7 + 10 + 0 + 10 + 0 + 4 = **51**
- Data Credits = 10×0.5 + 7.1 + 7×0.1 + 10×2.0 + 0 = 5 + 7.1 + 0.7 + 20 = **32.8**

## R1 (filter-too-late)

Paid steps before filter on the 6 ICP-fail rows:
- contacts: 6×0.5 DC + 6 Act
- waterfall: 6×0.71 DC + 6 Act
- validate (assume 0.7×6 ≈ 4.2 rows): ~4.2×0.1 DC + 4.2 Act
- employee: 6×2.0 DC + 6 Act
- use_ai: 6 Act

Engine computes exact waste via re-simulation after moving filter first.

## R4 reorder (hitRate / dataCredit)

Score = hitRate / dataCreditCost:
- Findymail: 0.5 / 0.5 = 1.0
- Prospeo: 0.4 / 0.3 ≈ 1.333
- Hunter: 0.25 / 0.2 = 1.25

Recommended order: Prospeo → Hunter → Findymail

```
E' = 0.3
   + 0.2 × (1 − 0.4)
   + 0.5 × (1 − 0.4) × (1 − 0.25)
   = 0.3 + 0.12 + 0.225
   = 0.645
```

Savings per row ≈ 0.71 − 0.645 = 0.065 DC.

## R5

Replace `use_ai` title cleanup with `ai_formula` → save 10 Actions (or 4 after ICP pushdown).
