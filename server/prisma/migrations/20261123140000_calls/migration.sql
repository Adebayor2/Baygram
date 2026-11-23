CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');
CREATE TYPE "CallStatus" AS ENUM ('MISSED', 'REJECTED', 'CANCELED', 'COMPLETED', 'FAILED');

CREATE TABLE "call_logs" (
  "id" UUID NOT NULL,
  "caller_id" UUID NOT NULL,
  "callee_id" UUID NOT NULL,
  "type" "CallType" NOT NULL,
  "status" "CallStatus" NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "duration_sec" INTEGER,
  CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "call_logs_caller_id_started_at_idx" ON "call_logs"("caller_id", "started_at" DESC);
CREATE INDEX "call_logs_callee_id_started_at_idx" ON "call_logs"("callee_id", "started_at" DESC);

ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_caller_id_fkey"
FOREIGN KEY ("caller_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_callee_id_fkey"
FOREIGN KEY ("callee_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "call_logs" ENABLE ROW LEVEL SECURITY;
