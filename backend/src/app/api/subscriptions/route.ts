import { readyDb } from "@/lib/db";
import { createSubscriptionHandlers } from "@/lib/subscription-request";

export const { POST, DELETE } = createSubscriptionHandlers({ getDatabase: readyDb });
