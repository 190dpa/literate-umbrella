/*
  Warnings:

  - The `status` column on the `BanAppeal` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `rarityColor` on the `Character` table. All the data in the column will be lost.
  - You are about to drop the column `rarityName` on the `Character` table. All the data in the column will be lost.
  - The `status` column on the `Ticket` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `giftType` on the `GiftLink` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "Rarity" AS ENUM ('COMUM', 'RARO', 'EPICO', 'LENDARIO', 'MITICO', 'SUPREME');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GiftType" AS ENUM ('COINS', 'CHARACTER');

-- DropForeignKey
ALTER TABLE "Character" DROP CONSTRAINT "Character_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_authorId_fkey";

-- AlterTable
ALTER TABLE "BanAppeal" DROP COLUMN "status",
ADD COLUMN     "status" "AppealStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Character" DROP COLUMN "rarityColor",
DROP COLUMN "rarityName",
ADD COLUMN     "attack" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "health" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "rarity" "Rarity" NOT NULL DEFAULT 'COMUM',
ALTER COLUMN "buffDescription" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GiftLink" DROP COLUMN "giftType",
ADD COLUMN     "giftType" "GiftType" NOT NULL;

-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "status",
ADD COLUMN     "status" "TicketStatus" NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "Sword" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "attackBonus" INTEGER NOT NULL,
    "rarity" "Rarity" NOT NULL DEFAULT 'COMUM',
    "imageUrl" TEXT,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "Sword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminStats" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "attack" INTEGER NOT NULL DEFAULT 999,
    "health" INTEGER NOT NULL DEFAULT 9999,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminStats_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sword" ADD CONSTRAINT "Sword_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
