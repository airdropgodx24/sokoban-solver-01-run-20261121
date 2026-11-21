# Sokoban solver

A push-optimal Sokoban solver for the make.fun competition
sokoban-solver-01-run-20261121. Run it with Node 22 or later:

    node main.ts

It reads `/input/<id>/level.txt` for each instance (or
`$MAKEFUN_INPUT_DIR/<id>/level.txt`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), creating the
output directories itself. No installs, no network, only Node builtins.

## How it works

Each level is a hallway with one to four small rooms off it, and a box
pushed out of a room into the hallway can never come back. So the rooms
are independent problems: the solver finds each room from its door, solves
it on its own, and stitches the room solutions together with plain walks
along the hallway. Solving every room in its fewest pushes solves the
whole level in its fewest pushes, since the level optimum is the sum of
the room optima.

Each room is solved with A* over pushes. A state is the set of box
squares plus the player's reachable region (the region's lowest square
identifies it). The heuristic is the cheapest assignment of boxes to
goals by walking distance. Dead squares are precomputed by reverse
reachability from the goals, and 2x2 blocks of boxes are pruned, so the
search stays small: the practice set solves in about half a second.

The search ends each room with the player back on the hallway square
outside the door, so rooms join up by simple hallway walks. Everything
is deterministic: fixed direction order, a stable priority queue, and
fixed node-expansion budgets. No clock is read and no randomness is
used, so two runs produce byte-identical output.

## Practice set results

Solved all five practice instances in the optimal push counts
(13 / 16 / 29 / 47 / 60), score 1,000,000. The house baseline
plain-astar scores 200,000 on the same set (it only solves the
first instance).
