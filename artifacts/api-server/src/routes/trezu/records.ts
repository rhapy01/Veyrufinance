import { desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  employeesTable,
  invoicesTable,
  vendorApplicationsTable,
} from "@workspace/db";
import { GetRecordsResponse } from "@workspace/api-zod";
import {
  requireWorkspaceMember,
  requireWorkspaceRole,
} from "../../middlewares/auth";

const router: IRouter = Router();

router.get(
  "/records",
  requireWorkspaceMember,
  requireWorkspaceRole("owner", "admin"),
  async (req, res): Promise<void> => {
    const [invoices, employees, applications] = await Promise.all([
      db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(invoicesTable.createdAt)),
      db
        .select()
        .from(employeesTable)
        .where(eq(employeesTable.workspaceId, req.trezuWorkspaceId!))
        .orderBy(desc(employeesTable.createdAt)),
      db
        .select()
        .from(vendorApplicationsTable)
        .where(eq(vendorApplicationsTable.applicantUserId, req.trezuUserId!))
        .orderBy(desc(vendorApplicationsTable.createdAt)),
    ]);

    const records = [
      ...invoices.map((invoice) => ({
        id: invoice.id,
        recordType: "invoice" as const,
        title: `Invoice ${invoice.invoiceNumber} for ${invoice.clientName}`,
        status: "Draft",
        createdAt: invoice.createdAt,
      })),
      ...employees.map((employee) => ({
        id: employee.id,
        recordType: "payroll_profile" as const,
        title: `Payroll profile for ${employee.name}`,
        status: "Compensation setup only",
        createdAt: employee.createdAt,
      })),
      ...applications.map((application) => ({
        id: application.id,
        recordType: "vendor_application" as const,
        title: `Vendor application for ${application.businessName}`,
        status: application.status,
        createdAt: application.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json(GetRecordsResponse.parse(records));
  },
);

export default router;
