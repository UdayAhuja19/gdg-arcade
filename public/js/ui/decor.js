const SVG_NS = "http://www.w3.org/2000/svg";

// A brand shape from the sprite, coloured by one of the brand colour names.
export function shapeEl(shape, color, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `shape shape--${color === "ink" ? "blue" : color} ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `assets/shapes.svg#${shape}`);
  svg.append(use);
  return svg;
}

export const BUTTON_CLASS = {
  green: "btn--green",
  yellow: "btn--primary",
  blue: "btn--blue",
  red: "btn--red",
  ink: "btn--ink",
};
