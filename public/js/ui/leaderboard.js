import { formatScore } from "./format.js";

// Always renders three rows so the board keeps its shape; empty spots invite a challenger.
export function renderBoard(list, rows, { meId = null } = {}) {
  list.replaceChildren();
  for (let i = 0; i < 3; i += 1) {
    const row = rows?.[i];
    const li = document.createElement("li");
    li.className = "board__row";
    const rank = document.createElement("span");
    rank.className = "board__rank";
    rank.textContent = String(i + 1);
    const name = document.createElement("span");
    name.className = "board__name";
    const score = document.createElement("span");
    score.className = "board__score";

    if (row) {
      name.textContent = row.name;
      score.textContent = formatScore(row.score);
      if (meId != null && row.playerId === meId) li.classList.add("is-me");
    } else {
      li.classList.add("board__row--empty");
      name.textContent = "OPEN SPOT";
      score.textContent = "—";
    }
    li.append(rank, name, score);
    list.append(li);
  }
}
