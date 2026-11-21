import { cloudinary } from "../../config/cloudinary.js";

export interface MediaDestroyJob {
  publicId: string;
  type: "IMAGE" | "VIDEO";
}

export async function processMediaDestroy(job: MediaDestroyJob): Promise<void> {
  await cloudinary.uploader.destroy(job.publicId, {
    resource_type: job.type === "VIDEO" ? "video" : "image",
    invalidate: true,
  });
}
