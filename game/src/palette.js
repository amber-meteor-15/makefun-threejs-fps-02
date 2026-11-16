// The look plan, in one place: a dusk foundry. Warm charcoal stone and rusted steel,
// a low amber sun, and two team colours that read at a glance across the yard. Every
// material and HUD colour in the game comes from this table; the CSS custom properties
// in index.html mirror the same values.
export const PALETTE = {
  canvas: '#241b13', // sky, fog and the page background
  ground: '#4d3f33', // yard paving
  surface: '#5f4d3e', // walls and buildings
  hairline: '#715c49', // trim, crates, cover
  steel: '#6e6259', // metal props and weapon bodies
  ink: '#f4ead8', // lit faces, text
  muted: '#a3907a', // secondary text, distant fill
  accent: '#ff9a3c', // foundry orange: muzzle flash, site A, warnings
  accentCool: '#57c7d4', // site B teal, defuse prompts
  warden: '#4da3ff', // the defending team (the player's)
  jackal: '#ff5d43', // the attacking team
  blood: '#c62f3b', // hit feedback
  foliage: '#5c6e3c', // the few planter boxes that soften the yard
};

export function color(name) {
  return PALETTE[name];
}
