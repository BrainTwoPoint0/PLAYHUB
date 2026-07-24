-- Refiner confidence as a RECORDED SIGNAL on goal candidates (spike gate
-- PASS: freeze-OOF P@4 0.673 vs span-alone 0.492 — scripts/event-tagging/
-- refiner/PROTOCOL.md). NULL = row predates the refiner (no badge).
-- Signal only: never filters, never reorders review; approve stays human.
alter table public.playhub_goal_candidates
  add column if not exists confidence numeric;
