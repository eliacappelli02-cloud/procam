import { createFileRoute } from "@tanstack/react-router";
import { ActionCam } from "@/components/ActionCam";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ProCam — Action cam per iPhone con loop recording" },
      { name: "description", content: "Trasforma il tuo iPhone in un'action cam: video, foto, burst, time-lapse e registrazione in loop." },
      { property: "og:title", content: "ProCam — Action cam per iPhone" },
      { property: "og:description", content: "Video, burst, time-lapse e loop recording direttamente dal browser." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ActionCam,
});
