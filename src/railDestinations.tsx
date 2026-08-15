// railDestinations — the app-level destinations that sit at the foot of
// whichever sidebar is on screen.
//
// One rail renders them now (WorkspaceRail's foot, in every shell), but the
// set — what a destination is, its id, label, and icon — stays defined here
// rather than inside the component that draws it: a destination is an
// app-level fact, and this module is what the shells agreed on back when there
// were two rails to keep in step.

import { ProfileIcon, SettingsIcon, type GlyphProps } from "./icons";

/** The panel ids a destination can open. Matches the `View` union both rails
 *  speak; kept as a narrow literal set so a typo can't slip through. */
export type RailDestinationId = "settings" | "profile";

/** The icons take a size, so a surface can draw them at its own density.
 *  Weight is not a parameter: ./icons owns it for the whole app, which is what
 *  stopped the rails drifting apart while there were two of them. */
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
