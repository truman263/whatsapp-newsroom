-- CreateEnum
CREATE TYPE "EditorialCategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Reporter" ADD COLUMN     "editorialByline" VARCHAR(200);

-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "byline" VARCHAR(200);

-- CreateTable
CREATE TABLE "EditorialCategory" (
    "id" UUID NOT NULL,
    "wordpressCategoryId" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(200) NOT NULL,
    "status" "EditorialCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EditorialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryCategory" (
    "storyId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryCategory_pkey" PRIMARY KEY ("storyId","categoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EditorialCategory_wordpressCategoryId_key" ON "EditorialCategory"("wordpressCategoryId");

-- CreateIndex
CREATE INDEX "EditorialCategory_status_idx" ON "EditorialCategory"("status");

-- CreateIndex
CREATE INDEX "EditorialCategory_slug_idx" ON "EditorialCategory"("slug");

-- CreateIndex
CREATE INDEX "StoryCategory_categoryId_idx" ON "StoryCategory"("categoryId");

-- AddForeignKey
ALTER TABLE "StoryCategory" ADD CONSTRAINT "StoryCategory_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryCategory" ADD CONSTRAINT "StoryCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "EditorialCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
