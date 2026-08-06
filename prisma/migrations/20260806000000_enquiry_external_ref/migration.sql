-- AlterTable
ALTER TABLE "Enquiry" ADD COLUMN     "externalRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Enquiry_externalRef_key" ON "Enquiry"("externalRef");

