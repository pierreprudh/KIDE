// railDestinations — the app-level destinations that sit at the foot of
// whichever sidebar is on screen.
//
// Two rails render them: the free-mode ActivityBar's bottom zone and the
// Focus rail's foot. They render differently (a dock-dot row vs a labeled
// row beside the identity card), but the *set* — what a destination is, its
// id, label, and icon — is defined once, here. Adding a destination should
// never mean remembering to edit a second rail.

/** The panel ids a destination can open. Matches the `View` union both rails
 *  speak; kept as a narrow literal set so a typo can't slip through. */
export type RailDestinationId = "settings" | "profile";

/** Each rail draws these at its own density — the free-mode rail's rows are
 *  18px/1.25, the Focus rail's are 15px/1.7 — so the icons take both rather
 *  than forcing one rail to look off next to its neighbours. */
export type RailIconProps = { size?: number; strokeWidth?: number };

export type RailDestination = {
  id: RailDestinationId;
  label: string;
  Icon: (props: RailIconProps) => React.JSX.Element;
};

export function SettingsIcon({ size = 18, strokeWidth = 1.25 }: RailIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M16 4v4" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M9 10v4" />
      <path d="M4 18h11" />
      <path d="M19 18h1" />
      <path d="M17 16v4" />
    </svg>
  );
}

export function ProfileIcon({ size = 18, strokeWidth = 1.4 }: RailIconProps) {
  // Person silhouette with a small status dot bottom-right — the
  // "you, on this machine" entry in the bottom zone.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="9" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
      <circle cx="18.5" cy="17.5" r="1.6" fill="var(--success)" stroke="none" />
    </svg>
  );
}

/** The destinations, in rail order. */
export const RAIL_DESTINATIONS: readonly RailDestination[] = [
  { id: "settings", label: "Settings", Icon: SettingsIcon },
  { id: "profile", label: "Profile", Icon: ProfileIcon },
];

/** Look one up by id — for rails that render a destination in a bespoke form
 *  (Focus draws Profile as the identity card) but still want its label and
 *  icon to come from the shared definition. */
export function railDestination(id: RailDestinationId): RailDestination {
  const found = RAIL_DESTINATIONS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown rail destination: ${id}`);
  return found;
}
