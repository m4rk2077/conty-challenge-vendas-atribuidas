import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { SalesService } from './service.js';

export function seedDemo(service: SalesService): void {
  service.putCreatorCode({ store_id: 'store_a', code_type: 'coupon', code: 'LIA20', creator_id: 'crt_lia', active: true });
  service.putCreatorCode({ store_id: 'store_a', code_type: 'utm', code: 'creator:crt_bia', creator_id: 'crt_bia', active: true });
  service.putCreatorCode({ store_id: 'store_b', code_type: 'coupon', code: 'LIA20', creator_id: 'crt_ana', active: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const db = openDatabase(process.env.DB_PATH ?? './data/sales.sqlite');
  try {
    seedDemo(new SalesService(db));
    console.log('Códigos de demonstração cadastrados em store_a e store_b.');
  } finally { db.close(); }
}
