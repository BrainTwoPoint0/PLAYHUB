// Slot-gated re-acquisition for the Explore Spotlight "Lock".
//
// When a Lock carries a jersey slot it must re-acquire ONLY via that slot
// (slotMate — a same-slot fragment at any distance). The geometry paths in
// VirtualPanoramaPlayer.tsx (the in-window nearestObject hop and the WATCHING
// co-located pickup) adopt whatever non-conflicting body is nearest — at ~0.7%
// label coverage almost nothing conflicts, so at a crossing the ring adopts a
// stranger who walks into the frozen circle, and can even flip its badge to the
// stranger's number. These pure predicates are what the RAF re-acquire loop
// gates on; kept here so both re-acquire paths and the upgrade guard are tested.

/**
 * Geometry re-acquire — the in-window `nearestObject` hop AND the WATCHING
 * co-located pickup — runs ONLY for an UNLABELLED Lock. A slotted Lock
 * re-acquires solely via `slotMate`, so any other geometry pickup is a stranger
 * (kills "#10 → unlabelled stranger under the #10 badge").
 */
export const geometryReacquireEnabled = (selSlot: string | null): boolean =>
  selSlot === null

/**
 * Identity-upgrade guard: a geometry pickup may hand its slot label to the
 * selection ONLY when
 *  - the Lock is currently UNLABELLED (a slotted Lock is NEVER relabelled by
 *    geometry — that would silently turn #10 into #5), AND
 *  - the pickup actually carries a slot, AND
 *  - the evidence is CO-LOCATED (a ~0.5° same-spot re-index is genuinely the
 *    same body gaining its label; a 1–2° pickup is a stranger and must not flip
 *    the badge).
 * The in-window path already required co-location; the WATCHING path did not —
 * this unifies them.
 */
export const colocatedUpgradeAllowed = (
  selSlot: string | null,
  candSlot: string | undefined,
  isCoLocated: boolean
): boolean => selSlot === null && candSlot !== undefined && isCoLocated

/**
 * Jersey number to caption while a slotted Lock is WATCHING. A kit slot is
 * `<kit letter><number>` with an optional `-<dup>` suffix ("a10", "a10-2" →
 * "10"); the number is that player's jersey. GK ZONE slots are the only
 * jersey-less form and are reserved as `g<digit>` ("g1".."g4") — they, and
 * null, carry no jersey number → null (the caller shows a generic caption).
 * Keying off the GK reservation (not an assumed `a–f` alphabet) matches the
 * slot grammar in tracklets.ts, which admits kit letters across `a–z`.
 */
export const slotWatchNumber = (slot: string | null): string | null =>
  slot && !/^g\d/.test(slot) ? (slot.match(/\d{1,2}/)?.[0] ?? null) : null
