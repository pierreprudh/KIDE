// railDestinations — the app-level destinations that sit at the foot of
// whichever sidebar is on screen.
//
// Two rails render them: the free-mode ActivityBar's bottom zone and the
// Focus rail's foot. They render differently (a dock-dot row vs a labeled
// row beside the identity card), but the *set* — what a destination is, its
// id, label, and icon — is defined once, here. Adding a destination should
// never mean remembering to edit a second rail.

import { ProfileIcon, SettingsIcon, type GlyphProps } from "./icons";

/** The panel ids a destination can open. Matches the `View` union both rails
 *  speak; kept as a narrow literal set so a typo can't slip through. */
export type RailDestinationId = "settings" | "profile";

/** Each rail draws these at its own density — the free-mode rail's rows are
 *  18px, the Focus rail's 15px — so the icons take a size. Weight is not a
 *  parameter: ./icons owns it for the whole app, which is what stopped the
 *  two rails drifting apart. */
export type RailIconProps = GlyphProps;

export type RailDestination = {
  id: RailDestinationId;
  label: string;
  Icon: (props: RailIconProps) => React.JSX.Element;
};

/* The glyphs themselves live in ./icons with the rest of the vocabulary.
   Re-exported here so callers that think in destinations ("give me the
   Settings mark") don't have to know which module drew it. */
export { SettingsIcon, ProfileIcon };

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
