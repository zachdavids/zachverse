/** A section of a long page: a heading, its paragraphs, and an optional list, numbered when its order matters. */
export interface Section {
  /** Stable: the section's anchor on its page, so never reused for another section. */
  id: string;
  heading: string;
  paragraphs: readonly string[];
  list?: readonly string[];
  ordered?: boolean;
  /** Optional reading: its heading shows, and its text stays closed until the reader opens it. */
  deepDive?: boolean;
}
