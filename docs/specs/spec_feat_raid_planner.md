# Raid planner feature

The aim of this feature is to help the user plan raids by suggesting efficient weapon/tool combinations to destroy a given structure.

When the Rust Overlay is active, the user can invoke the raid planner by pressing F5.
The behavior following the F5 key press depends on whether or not the user is targeting a structure with the hammer to show its HP or not.

**If the user is targeting a structure with the hammer (HP fraction visible):**
A screenshot is taken, the displayed HP fraction (current/max) is evaluated to determine what structure we are dealing with and how much of its HP is left.

<ToDo>The HP fraction alone does not provide sufficient information to identify a unique structure (e.g. a wood tier wall and sheet metal door both have 250HP), so we need a way to either automatically determine the structure from other information in the image or for the user to select the appropriate structure among a list of identified candidates.</ToDo>

<ToDo>The HP fraction gives no information about soft- or hard-side of certain structures. We need to figure out an easy way to either auto-detect this from the image or for the user to select it when the information is relevant.</ToDo>

<ToDo>Boats are a particular structure where the HP fraction is not fixed, it depends on the boat design, we need to figure out how to handle this case in an ergonomic fashion</ToDo>

**If the user is not targeting a structure with a hammer:**
The overlay displays a fallback menu tree with top-level grouping by building grade: Twig / Wood / Stone / Metal / Armored -> wall, doorway, window, foundation...; doors, gates and barricades as sibling top-level groups. The user can navigate the menu to select the structure they plan to raid and the tool will assume maximum HP.

**In both cases:**
Once the structure is identified and the remaining HP is known (read off the visible fraction or estimated to be maximum HP), a database holding all damage values per weapon/tool for all structures is used to determine the most efficient raid methods.

Destroying the structure means bringing the target structure's HP to 0. Structures cannot have negative HP.

Efficiency can be measured through three criteria:
* Number of items (munitions/tools) required to destroy the structure: lower is better
* Total ressource cost of items required to destroy the structure: lower is better
* Time to destroy structure: shorter is better
* Distance at which the raid can be heard: smaller is better

<ToDo>We will need to determine the exact methods for calculating this, once preliminary data collection is finished.</ToDo>

Finally, the tool will have to provide at least one suggestion per workbench tier so that the feature is useful at all stages of the game.

## Database and data collection

### Damage calculation

Raidable game structures are manually recorded in `data/raid-structures.json` (JSON in data/ is the repo convention for data).

<ToDo>Some craftable structures (e.g. barricades, doors) have a known shortname already featured in `data/recipes.json`. However, we don't know the shortnames for building structures (e.g. sheet metal wall, twig triangle foundation) and a preliminary internet search hasn't helped. Can these shortnames be extracted from the Rust game files or somewhere we missed online, or should the user simply create a custom shortname syntax when filling in `data/raid-structures.json`?</ToDo>

Damage data are manually recorded in `data/raid-damage.json`.

Damage will be recorded per hit for munitions and per item for tools with durability. A C4 does its damage once; a rocket once; a pickaxe has durability for N hits but will do fixed damage to a structure with those N hits, so no need to record damage per hits and to multiply it by N, we just record damage per full use of a pickaxe. 

Special damage (fire damage, explosive damage) will also be directly baked into the recorded damage values, no need to reverse-engineer Rust's damage algorithm.

Damage data is filled in manually by the user using the json template.

The damage table above deliberately has **no cost/tier fields**: the planner joins weapon shortname → `recipes.json` for cost and workbench tier. 

### Cost calculation

`data/recipes.json` already exists and contains ingredients, workbench tier, amountToCreate for all craftable items (including munitions & tools). The raid cost calculation will simply reuse this data.

## Database auditing

<ToFill>

## Testing

The user will collect in-game screenshots with and without a structure HP fraction visible in the `captures/raid/` folder (gitignored, local-only) for testing purposes. Expected values encoded in filenames (`wall-stone_320_500.png`, `negative_01.png` for no-HP cases) so a verification tool can later score the HP reader the way `sim-counts` scores the matcher.

<ToDo>Manual collection is tedious, we should create a small tool that can run next to the game, allowing the user to press F7 to grab a screenshot in exactly the same way as the Rust Overlay does for the recycler calculation (and will do for the raid planner calculation). Screenshots should be saved to the `captures/raid/` folder (maybe the user can specify the absolute path to this folder via a config file?). The user can then manually rename the files as per the convention after having collected several screenshots, avoiding a constant back-and-forth between the desktop and the game during collection.</ToDo>