# 3-minute demo script

## Opening (20s)

“Clay already estimates cost **before** a run. This estimates **waste after** you define the workflow — Actions and Data Credits as separate meters, the way Clay bills.”

## Live path (90s)

1. Open the app — sample CSV is your real 30-domain export; workflow JSON is the wasteful “before” order.
2. Point at health strip: **Actions** vs **Data Credits** (not one blended number).
3. Open **R1**: ICP filter is free and last; SMARTe alone was **18 of 25.7** Data Credits in Clay Usage — moving ICP earlier is predicate pushdown.
4. Open **R4**: waterfall E[cost] = Σ priceᵢ × P(earlier misses). We reorder by hit rate per credit using this table’s provider-win column (Findymail) plus declared alternates.
5. Open **R5**: title cleanup tagged deterministic → downgrade Use AI → free AI Formula.
6. Expand **Why not GPT?** — show engine JSON. Model only narrates; it does not invent savings.

## Whiteboard formulas (30s)

- Actions/run = Σ rowsReaching × actionCost  
- Data Credits/run = single enrichments + waterfall E[cost]  
- Blank ≠ paid failure (run-condition-not-met **or** refund)

## Engineer FAQ (40s)

**Why not GPT?** No reliable row accounting or dual-meter math.  
**CS idea?** Workflow = DAG; filters are free predicates; waterfalls are expected-cost under a miss chain.  
**Scale?** Profile CSV once (O(rows)); optimize on summary stats O(steps² + providers log providers).  
**Doesn’t Clay already order waterfalls?** Defaults are cost-aware; we personalize from *this table’s* hit rates.  
**Ask them:** Can an export tell skip vs failed-and-refunded blanks?

## V2 (say, don’t build)

Bounce/reply ROI, continuous failure monitor, CRM preview, richer export metadata if Clay exposes skip vs fail.
