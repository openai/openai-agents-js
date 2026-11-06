-- Dumped from the example schema using Prisma CLI/client 6.19.0.
-- The synthetic date is 2025-10-01T12:34:56.789Z; DateTime values are
-- integer milliseconds and item is the example's JSON-encoded string.
BEGIN TRANSACTION;
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "Session" VALUES('prisma6-session',1759322096789,1759322096789);
CREATE TABLE "SessionItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "item" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "SessionItem" VALUES(1,'prisma6-session',1,'"{\"role\":\"user\",\"content\":\"Retained Prisma 6 history\"}"',1759322096789);
CREATE INDEX "SessionItem_sessionId_position_idx" ON "SessionItem"("sessionId", "position");
CREATE UNIQUE INDEX "SessionItem_sessionId_position_key" ON "SessionItem"("sessionId", "position");
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('SessionItem',1);
COMMIT;
