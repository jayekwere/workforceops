import type { Employee } from './workforce.js';
import { Store } from './store.js';
export const employees: Employee[] = [
  {
    id: 'worker-001',
    tenant: 'sandbox',
    name: 'Synthetic Engineer',
    email: 'engineer@example.invalid',
    department: 'engineering',
    employment: 'active',
  },
  {
    id: 'worker-002',
    tenant: 'sandbox',
    name: 'Synthetic Operator',
    email: 'operator@example.invalid',
    department: 'operations',
    employment: 'active',
  },
  {
    id: 'worker-003',
    tenant: 'sandbox',
    name: 'Synthetic Departure',
    email: 'departure@example.invalid',
    department: 'engineering',
    employment: 'departed',
  },
];
export function seedCatalog(store: Store) {
  for (const e of employees)
    if (!store.get(e.tenant, 'employee', e.id)) store.put(e.tenant, 'employee', e.id, e);
}
