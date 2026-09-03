import { seedDatabase, REFERENCE_TENANT_ID } from '../src/services/seed-data-service';

async function main() {
  console.log('Seeding Supabase database for tenant:', REFERENCE_TENANT_ID);
  const result = await seedDatabase(REFERENCE_TENANT_ID);
  if (result.ok) {
    console.log(`Successfully seeded ${result.count} records into Supabase!`);
  } else {
    console.log('Seed note:', result.error);
  }
}

main().catch(console.error);
