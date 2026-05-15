-- Tagging system: normalised tags table + many-to-many join.
-- COLLATE NOCASE so 'Travel' and 'travel' collapse to one tag (first
-- writer wins on casing). ON DELETE CASCADE keeps post_tags clean
-- when a post row is dropped during reindex orphan-removal.

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL COLLATE NOCASE
);

CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- Supports "all posts for tag X" join without a full-table scan.
CREATE INDEX post_tags_tag ON post_tags(tag_id, post_id);
