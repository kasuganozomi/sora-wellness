import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { hashPassword } from '../src/shared/security';
import { Db } from '../src/shared/db';
import { SiteService } from '../src/content/site.service';
import { demoDocument } from './demo-content';

type Person = { name: string; email: string; role: 'admin' | 'coach' | 'customer'; password: string; id: string };
type Class = { title: string; category: string; level: string; description: string; duration: number; capacity: number; price: number };

const root = resolve(process.cwd(), '..');
const uploadDir = resolve(process.cwd(), process.env.MEDIA_STORAGE_DIR ?? 'uploads');
const imageDir = resolve(root, 'frontend/public/images');
const classes: Class[] = [
  { title: 'Gentle Flow', category: 'Yoga', level: 'beginner', description: 'Alur yoga yang lembut untuk membangun kebiasaan bergerak dan bernapas.', duration: 60, capacity: 12, price: 75000 },
  { title: 'Pilates Foundation', category: 'Pilates', level: 'beginner', description: 'Dasar gerak pilates mat dengan perhatian pada stabilitas tubuh.', duration: 60, capacity: 10, price: 90000 },
  { title: 'Morning Mobility', category: 'Mobilitas', level: 'beginner', description: 'Gerak sendi dan peregangan aktif untuk mengawali hari.', duration: 45, capacity: 12, price: 70000 },
  { title: 'Power Flow', category: 'Yoga', level: 'intermediate_1', description: 'Rangkaian gerak yang lebih dinamis untuk membangun kekuatan dan fokus.', duration: 60, capacity: 10, price: 100000 },
  { title: 'Strength & Balance', category: 'Pilates', level: 'intermediate_1', description: 'Latihan kendali, keseimbangan, dan kekuatan inti tingkat lanjut.', duration: 60, capacity: 10, price: 105000 },
  { title: 'Deep Practice', category: 'Yoga', level: 'intermediate_2', description: 'Eksplorasi teknik dan ketahanan bagi peserta yang telah berpengalaman.', duration: 75, capacity: 8, price: 120000 },
  { title: 'Open Studio', category: 'Komunitas', level: 'beginner', description: 'Sesi pengenalan gratis dengan suasana santai dan ruang untuk bertanya.', duration: 45, capacity: 15, price: 0 },
];
const customerNames = ['Ayu Lestari', 'Dimas Saputra', 'Lila Mahendra', 'Maya Kirana', 'Raka Pratama', 'Sinta Dewi'];
const assets = [
  ['logo', 'sora-mark.png'], ['hero', 'sora-studio-hero.png'], ['yoga', 'sora-yoga-class.png'],
  ['pilates', 'sora-pilates-class.png'], ['reception', 'sora-reception.png'], ['recovery', 'sora-recovery.png'],
] as const;

function localOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL belum diatur');
  const url = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.port !== '55432') throw new Error('Demo hanya boleh memakai PostgreSQL lokal port 55432');
  if (process.env.NODE_ENV === 'production' || process.env.MIDTRANS_ENV !== 'sandbox') throw new Error('Demo hanya boleh dijalankan di lingkungan Midtrans Sandbox nonproduksi');
}

async function backup(): Promise<string> {
  const path = resolve(process.cwd(), '.qa', `demo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(path, { recursive: true });
  await mkdir(uploadDir, { recursive: true });
  let bytes: Buffer;
  try {
    bytes = execFileSync('docker', [
      'compose', 'exec', '-T', 'db', 'pg_dump', '-U', process.env.DB_USER ?? 'wellness',
      '-d', process.env.DB_NAME ?? 'wellness', '-Fc',
    ], { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024 });
  } catch {
    const pgDumpCmd = process.platform === 'win32'
      ? (process.env.PGDUMP_BIN ?? 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe')
      : 'pg_dump';
    bytes = execFileSync(pgDumpCmd, [
      '-h', '127.0.0.1', '-p', '55432', '-U', process.env.DB_USER ?? 'wellness',
      '-d', process.env.DB_NAME ?? 'wellness', '-Fc',
    ], { cwd: process.cwd(), maxBuffer: 50 * 1024 * 1024, env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } });
  }
  if (bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Cadangan PostgreSQL tidak valid');
  await writeFile(resolve(path, 'database.dump'), bytes);
  await cp(uploadDir, resolve(path, 'uploads'), { recursive: true, force: true });
  return path;
}

async function insertPerson(client: PoolClient, name: string, email: string, role: Person['role']): Promise<Person> {
  const password = randomBytes(18).toString('base64url');
  const result = await client.query<{ id: string }>(
    'INSERT INTO app_users (email,full_name,role,password_hash,password_change_required) VALUES ($1,$2,$3,$4,false) RETURNING id',
    [email, name, role, await hashPassword(password)],
  );
  return { id: result.rows[0].id, name, email, role, password };
}

function day(base: string, offset: number): string {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function booking(client: PoolClient, customerId: string, sessionId: string, confirmedAt: Date) {
  return (await client.query<{ id: string }>(
    `INSERT INTO bookings (customer_id,session_id,status,source,price_idr,idempotency_key,confirmed_at,created_at)
     VALUES ($1,$2,'confirmed','free',0,$3,$4,$4) RETURNING id`,
    [customerId, sessionId, `demo-free-${randomUUID()}`, confirmedAt],
  )).rows[0].id;
}

async function reset(client: PoolClient) {
  await client.query('UPDATE studio SET logo_media_id=NULL,hero_media_id=NULL WHERE id=1');
  const tables = [
    'site_content_media', 'site_publications', 'site_content', 'studio_gallery',
    'attendance_corrections', 'attendance', 'health_snapshots', 'health_profile_revisions', 'health_profiles',
    'wallet_entries', 'payment_transactions', 'bookings', 'locker_assignments', 'lockers',
    'memberships', 'package_purchases', 'wallet_accounts', 'class_sessions', 'schedule_rules',
    'class_types', 'package_options', 'media_assets', 'audit_logs', '"session"', 'app_users',
  ];
  for (const table of tables) await client.query(`DELETE FROM ${table}`);
  await client.query(`UPDATE studio SET name='Sora Wellness',slug='sora-wellness',description='',address='',hero_title='',hero_subtitle='',timezone='Asia/Makassar',updated_at=now() WHERE id=1`);
  await client.query(`UPDATE studio_policy SET guest_schedule_days=7,member_schedule_days=30,booking_cutoff_minutes=120,cancellation_cutoff_minutes=1440,seat_hold_minutes=15,monthly_class_quota=8,locker_enabled=true,updated_at=now() WHERE studio_id=1`);
}

async function main() {
  localOnly();
  const backupPath = await backup();
  process.stdout.write(`Cadangan: ${backupPath}\n`);
  const local = JSON.parse(await readFile(resolve(process.cwd(), '.demo.local.json'), 'utf8').catch(() => '{}')) as { phone?: string; whatsapp?: string; mapEmbedUrl?: string };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const createdFiles: string[] = [];
  const people: Person[] = [];
  const media = {} as Record<(typeof assets)[number][0], string>;
  const classIds: Record<string, string> = {};
  const packageIds: Record<number, string> = {};
  try {
    const today = (await pool.query<{ day: string }>(`SELECT (now() AT TIME ZONE 'Asia/Makassar')::date::text AS day`)).rows[0].day;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await reset(client);
      people.push(await insertPerson(client, 'Admin Sora', 'admin@sora.example.test', 'admin'));
      people.push(await insertPerson(client, 'Nadia Putri', 'nadia@sora.example.test', 'coach'));
      people.push(await insertPerson(client, 'Made Arya', 'arya@sora.example.test', 'coach'));
      for (const name of customerNames) people.push(await insertPerson(client, name, `${name.toLowerCase().replace(' ', '.')}@sora.example.test`, 'customer'));
      const admin = people[0];
      await mkdir(uploadDir, { recursive: true });
      for (const [key, name] of assets) {
        const bytes = await readFile(resolve(imageDir, name));
        if (bytes.length > 5 * 1024 * 1024) throw new Error(`Gambar ${name} melebihi 5 MB`);
        const id = randomUUID();
        const filename = `${id}.png`;
        const destination = resolve(uploadDir, filename);
        await copyFile(resolve(imageDir, name), destination);
        createdFiles.push(destination);
        await client.query('INSERT INTO media_assets (id,filename,mime_type,byte_size,storage_path,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, 'image/png', bytes.length, filename, admin.id]);
        media[key] = id;
      }
      await client.query('UPDATE studio SET logo_media_id=$1,hero_media_id=$2 WHERE id=1', [media.logo, media.hero]);
      for (const [position, key] of (['yoga', 'pilates', 'reception', 'recovery'] as const).entries()) await client.query('INSERT INTO studio_gallery (studio_id,media_id,position) VALUES (1,$1,$2)', [media[key], position]);
      for (const months of [1, 3, 6]) {
        const price = { 1: 450000, 3: 1200000, 6: 2250000 }[months as 1 | 3 | 6];
        packageIds[months] = (await client.query<{ id: string }>('INSERT INTO package_options (duration_months,price_idr) VALUES ($1,$2) RETURNING id', [months, price])).rows[0].id;
      }
      for (const type of classes) {
        classIds[type.title] = (await client.query<{ id: string }>(
          `INSERT INTO class_types (title,category,level,description,duration_minutes,default_capacity,default_price_idr)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [type.title, type.category, type.level, type.description, type.duration, type.capacity, type.price],
        )).rows[0].id;
      }
      const patterns = [
        { title: 'Gentle Flow', time: '07:00', weekdays: [1, 2, 3, 4, 5, 6], coach: 1 },
        { title: 'Pilates Foundation', time: '09:00', weekdays: [1, 2, 3, 4, 5, 6], coach: 2 },
        { title: 'Morning Mobility', time: '08:00', weekdays: [7], coach: 2 },
        { title: 'Power Flow', time: '16:00', weekdays: [2, 4, 6], coach: 1 },
        { title: 'Strength & Balance', time: '16:00', weekdays: [1, 5], coach: 2 },
        { title: 'Deep Practice', time: '15:00', weekdays: [3, 7], coach: 1 },
        { title: 'Open Studio', time: '17:00', weekdays: [1, 2, 3, 4, 5, 6, 7], coach: 2 },
      ];
      const sessionIds = new Map<string, string>();
      for (const pattern of patterns) {
        const type = classes.find((entry) => entry.title === pattern.title)!;
        for (const weekday of pattern.weekdays) {
          const rule = (await client.query<{ id: string }>(
            `INSERT INTO schedule_rules (class_type_id,coach_id,iso_weekday,local_start_time,starts_on,ends_on,capacity,price_idr)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [classIds[type.title], people[pattern.coach].id, weekday, pattern.time, day(today, -7), day(today, 45), type.capacity, type.price],
          )).rows[0].id;
          for (let offset = -7; offset <= 45; offset++) {
            const localDate = day(today, offset);
            const dayOfWeek = new Date(`${localDate}T00:00:00Z`).getUTCDay() || 7;
            if (dayOfWeek !== weekday) continue;
            const result = await client.query<{ id: string }>(
              `INSERT INTO class_sessions (class_type_id,schedule_rule_id,coach_id,local_date,starts_at,ends_at,capacity,price_idr)
               VALUES ($1,$2,$3,$4,($4::date+$5::time) AT TIME ZONE 'Asia/Makassar',(($4::date+$5::time) AT TIME ZONE 'Asia/Makassar')+$6::int*interval '1 minute',$7,$8)
               RETURNING id`,
              [classIds[type.title], rule, people[pattern.coach].id, localDate, pattern.time, type.duration, type.capacity, type.price],
            );
            sessionIds.set(`${type.title}:${localDate}`, result.rows[0].id);
          }
        }
      }
      for (const person of people.filter((entry) => entry.role === 'customer')) await client.query('INSERT INTO wallet_accounts (customer_id) VALUES ($1)', [person.id]);
      for (let number = 1; number <= 12; number++) await client.query('INSERT INTO lockers (code) VALUES ($1)', [`A-${String(number).padStart(2, '0')}`]);
      const lila = people.find((entry) => entry.name === 'Lila Mahendra')!;
      const sinta = people.find((entry) => entry.name === 'Sinta Dewi')!;
      const maya = people.find((entry) => entry.name === 'Maya Kirana')!;
      const pastDate = day(today, -2);
      const pastSession = sessionIds.get(`Open Studio:${pastDate}`)!;
      const pastStart = (await client.query<{ starts_at: Date; ends_at: Date }>('SELECT starts_at,ends_at FROM class_sessions WHERE id=$1', [pastSession])).rows[0];
      const lilaBooking = await booking(client, lila.id, pastSession, new Date(pastStart.starts_at.getTime() - 48 * 3600000));
      const sintaBooking = await booking(client, sinta.id, pastSession, new Date(pastStart.starts_at.getTime() - 48 * 3600000));
      const note = 'Pernah mengalami cedera pergelangan kaki; memilih gerakan dengan beban ringan saat diperlukan.';
      const recordedAt = new Date(pastStart.starts_at.getTime() - 10 * 86400000);
      await client.query('INSERT INTO health_profiles (customer_id,note,consented_at,updated_at) VALUES ($1,$2,$3,$3)', [lila.id, note, recordedAt]);
      await client.query('INSERT INTO health_profile_revisions (customer_id,note,recorded_at) VALUES ($1,$2,$3)', [lila.id, note, recordedAt]);
      await client.query('INSERT INTO health_snapshots (booking_id,customer_id,note,captured_at,delete_after) VALUES ($1,$2,$3,$4,$5)', [lilaBooking, lila.id, note, pastStart.starts_at, new Date(pastStart.ends_at.getTime() + 365 * 86400000)]);
      await client.query('INSERT INTO attendance (session_id,customer_id,booking_id,present,recorded_by,recorded_at) VALUES ($1,$2,$3,true,$4,$5),($1,$6,$7,true,$4,$5)', [pastSession, lila.id, lilaBooking, people[2].id, new Date(pastStart.ends_at.getTime() + 600000), sinta.id, sintaBooking]);
      await client.query(`INSERT INTO attendance_corrections (session_id,customer_id,booking_id,actor_id,previous_present,new_present,reason,corrected_at)
        VALUES ($1,$2,$3,$4,false,true,'Kehadiran dikonfirmasi ulang dari daftar studio',$5)`, [pastSession, sinta.id, sintaBooking, admin.id, new Date(pastStart.ends_at.getTime() + 2 * 3600000)]);
      await booking(client, maya.id, sessionIds.get(`Open Studio:${day(today, 2)}`)!, new Date());
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      for (const path of createdFiles) await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const db = new Db();
    try {
      const site = new SiteService(db);
      const current = await site.draft();
      const saved = await site.save(demoDocument(media, classIds, packageIds, local), current.draftVersion);
      await site.publish(saved.draftVersion, people[0].id);
    } finally {
      await db.onModuleDestroy();
    }
    const accountFile = resolve(process.cwd(), '.qa', 'demo-accounts.json');
    await mkdir(resolve(process.cwd(), '.qa'), { recursive: true });
    await writeFile(accountFile, JSON.stringify({ accounts: people.map(({ name, email, role, password }) => ({ name, email, role, password })) }, null, 2), { flag: 'w', mode: 0o600 });
    await unlink(resolve(process.cwd(), '.qa', 'demo-sandbox-state.json')).catch(() => undefined);
    process.stdout.write(`Data demo terpasang: ${people.length} akun, ${classes.length} jenis kelas, ${assets.length} media. Akun: ${accountFile}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
