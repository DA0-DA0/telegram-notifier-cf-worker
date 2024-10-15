-- Registration
DROP TABLE IF EXISTS registrations;

CREATE TABLE registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chainId TEXT NOT NULL,
  dao TEXT NOT NULL,
  chatId TEXT NOT NULL,
  messageThreadId TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- unique chain ID, DAO, chat ID, and message thread ID combo
  CONSTRAINT unique_registration UNIQUE (chainId, dao, chatId, messageThreadId)
);