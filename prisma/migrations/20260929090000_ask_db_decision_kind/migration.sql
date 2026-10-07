-- The "Ask the database" console logs every question to the AI audit log.
ALTER TYPE "AiDecisionKind" ADD VALUE IF NOT EXISTS 'db_question';
