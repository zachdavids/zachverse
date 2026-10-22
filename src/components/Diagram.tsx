import type { Architecture } from '../content/case-study.ts';

/**
 * The architecture before and after, side by side where there's room: each a column of boxes joined by arrows, drawn
 * in CSS. The boxes are lists, so a screen reader reads each path in order, and the arrows are decoration it skips.
 * Each list also says role="list": Safari doesn't expose a list drawn without markers as a list, and the role is
 * WebKit's documented way to keep it one.
 */
export function Diagram({ diagram }: { diagram: Architecture }) {
  const { before, after } = diagram;
  return (
    <figure className="diagram">
      <div className="paths">
        <div className="path">
          <h3>{before.label}</h3>
          <ol className="boxes" role="list">
            {before.boxes.map((box) => (
              <li key={box}>{box}</li>
            ))}
          </ol>
          <p className="note">{before.note}</p>
        </div>
        <div className="path">
          <h3>{after.label}</h3>
          <ul className="consumers" role="list">
            {after.consumers.map((consumer) => (
              <li key={consumer}>{consumer}</li>
            ))}
          </ul>
          <ol className="boxes" role="list">
            {after.boxes.map((box) => (
              <li key={box}>{box}</li>
            ))}
            <li className="container">
              <span>{after.container}</span>
              <ol className="boxes" role="list">
                {after.parts.map((part) => (
                  <li key={part}>{part}</li>
                ))}
              </ol>
            </li>
          </ol>
          <p className="note">{after.note}</p>
        </div>
      </div>
      <figcaption>{diagram.caption}</figcaption>
    </figure>
  );
}
