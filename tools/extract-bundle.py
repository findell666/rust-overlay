"""Extracts craft recipes and recycler data straight from the game's own asset bundle.

Rust ships Bundles/shared/items.preload.bundle with its type trees intact, so every
ItemDefinition and ItemBlueprint can be read without dumping IL2CPP metadata. That makes
the install the authoritative source for recipes too — re-run this after a patch and the
data follows the game.

    python3 tools/extract-bundle.py [--rust-dir PATH] [--out DIR]

Writes data/recipes.json.
"""

import argparse
import json
import os
import sys

try:
    import UnityPy
except ImportError:
    sys.exit("UnityPy manquant :  python3 -m pip install --user UnityPy")

DEFAULT_RUST_DIRS = [
    "C:/Program Files (x86)/Steam/steamapps/common/Rust",
    "C:/Program Files (x86)/Steam/steamapps/common/Rust",
    "C:/Program Files/Steam/steamapps/common/Rust",
    "D:/SteamLibrary/steamapps/common/Rust",
    # Same drives seen from WSL, so this runs from either side.
    "/mnt/c/Program Files (x86)/Steam/steamapps/common/Rust",
    "/mnt/c/Program Files/Steam/steamapps/common/Rust",
    "/mnt/d/SteamLibrary/steamapps/common/Rust",
]

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)


def resolve_rust_dir(explicit):
    for candidate in [explicit] if explicit else DEFAULT_RUST_DIRS:
        if candidate and os.path.isdir(os.path.join(candidate, "Bundles", "shared")):
            return candidate
    sys.exit("Installation de Rust introuvable — passe --rust-dir")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-dir")
    parser.add_argument("--out", default=os.path.join(PROJECT_ROOT, "data"))
    args = parser.parse_args()

    rust_dir = resolve_rust_dir(args.rust_dir)
    bundle = os.path.join(rust_dir, "Bundles", "shared", "items.preload.bundle")
    print(f"bundle : {bundle}")

    env = UnityPy.load(bundle)

    trees = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            trees[obj.path_id] = obj.read_typetree()
        except Exception:
            continue

    # An item's definition and its blueprint hang off the same GameObject.
    items_by_pathid = {}
    items_by_gameobject = {}
    for path_id, tree in trees.items():
        shortname = tree.get("shortname")
        if not shortname:
            continue
        items_by_pathid[path_id] = tree
        items_by_gameobject[tree["m_GameObject"]["m_PathID"]] = tree

    print(f"item definitions : {len(items_by_pathid)}")

    def shortname_of_pointer(pointer):
        target = items_by_pathid.get(pointer.get("m_PathID"))
        return target["shortname"] if target else None

    recipes = {}
    orphan_blueprints = 0
    unresolved_ingredients = 0

    for tree in trees.values():
        if "ingredients" not in tree or "amountToCreate" not in tree:
            continue

        owner = items_by_gameobject.get(tree["m_GameObject"]["m_PathID"])
        if not owner:
            orphan_blueprints += 1
            continue

        ingredients = {}
        for ingredient in tree["ingredients"]:
            name = shortname_of_pointer(ingredient.get("itemDef", {}))
            if not name:
                unresolved_ingredients += 1
                continue
            ingredients[name] = ingredients.get(name, 0) + ingredient["amount"]

        recipes[owner["shortname"]] = {
            "amountToCreate": tree.get("amountToCreate", 1),
            "craftTime": tree.get("time", 0),
            "workbench": tree.get("workbenchLevelRequired", 0),
            "userCraftable": bool(tree.get("userCraftable", 0)),
            "scrapRequired": tree.get("scrapRequired", 0),
            "scrapFromRecycle": tree.get("scrapFromRecycle", 0),
            "ingredients": ingredients,
        }

    print(f"recettes         : {len(recipes)}")
    print(f"blueprints orphelins : {orphan_blueprints}")
    print(f"ingrédients non résolus : {unresolved_ingredients}")

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "recipes.json")
    with open(out_path, "w", encoding="utf8") as handle:
        json.dump(
            {
                "_source": "Bundles/shared/items.preload.bundle of the local Rust install (type trees embedded in the bundle)",
                "recipeCount": len(recipes),
                "recipes": recipes,
            },
            handle,
            indent=2,
            ensure_ascii=False,
        )

    print(f"\nécrit {out_path}")

    for name in ("rifle.ak", "explosive.timed", "metal.facemask", "syringe.medical"):
        if name in recipes:
            print(f"\n{name}: {json.dumps(recipes[name], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
