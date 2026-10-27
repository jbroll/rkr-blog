ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'page'));
