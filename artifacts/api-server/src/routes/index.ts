import { Router, type IRouter } from "express";
import healthRouter from "./health";
import opencodeRouter from "./opencode";

const router: IRouter = Router();

router.use(healthRouter);
router.use(opencodeRouter);

export default router;
