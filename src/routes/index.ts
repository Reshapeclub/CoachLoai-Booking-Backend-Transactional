import { Router } from "express";
import memberRoutes from "./member.routes.js";
import adminRoutes from "./admin.routes.js";
import webhookRoutes from "./webhook.routes.js";
const router = Router();
router.use('/member', memberRoutes);
router.use('/admin', adminRoutes);
router.use('/webhooks', webhookRoutes);
export default router;
