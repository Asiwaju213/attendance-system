// Levels mirror the reference data pinned by the core schema migration. There
// is no public level-catalog endpoint, so the id↔name pairs established by the
// migration's single insert into an empty table are modelled explicitly to
// keep level-dependent screens deterministic. The label shows the level name
// while the value is the levels.id the backend expects.
export const ADMIN_LEVEL_OPTIONS: ReadonlyArray<{ id: number; name: number }> = [
  { id: 1, name: 100 },
  { id: 2, name: 200 },
  { id: 3, name: 300 },
  { id: 4, name: 400 },
  { id: 5, name: 500 },
];