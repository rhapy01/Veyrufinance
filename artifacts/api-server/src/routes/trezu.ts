import { Router, type IRouter } from "express";
import { requireAuthenticatedUser } from "../middlewares/auth";
import exchangeRouter from "./trezu/exchange";
import invoicesRouter from "./trezu/invoices";
import nearIntentsRouter from "./trezu/near-intents";
import payrollRouter from "./trezu/payroll";
import publicInvoicesRouter from "./trezu/public-invoices";
import recordsRouter from "./trezu/records";
import treasuryRouter from "./trezu/treasury";
import workspaceRouter from "./trezu/workspace";

const router: IRouter = Router();

router.use(publicInvoicesRouter);
router.use(requireAuthenticatedUser);
router.use(workspaceRouter);
router.use(invoicesRouter);
router.use(nearIntentsRouter);
router.use(payrollRouter);
router.use(treasuryRouter);
router.use(exchangeRouter);
router.use(recordsRouter);

export default router;
