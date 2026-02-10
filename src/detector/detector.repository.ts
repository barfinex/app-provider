// src/detector/detector.repository.ts
import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { EventSinkRepository } from '../questdb/event-sink/event-sink.repository';

export interface DetectorEntity {
    key: string;
    name: string;
    options: any;
    status: 'active' | 'deleted';
    createdAt: number;
    updatedAt: number;
    deletedAt?: number | null;
}

@Injectable()
export class DetectorRepository {
    constructor(
        private readonly reader: QuestDBQueryService,
        private readonly events: EventSinkRepository,
    ) { }

    // -------------------------------------------------
    // ESCAPE
    // -------------------------------------------------
    private esc(str: string): string {
        return str.replace(/'/g, "''");
    }

    // -------------------------------------------------
    // MAP ROW → ENTITY
    // -------------------------------------------------
    private rowToEntity(row: any): DetectorEntity {
        return {
            key: row.key,
            name: row.name,
            options: JSON.parse(row.options),
            status: row.status ?? 'active',
            createdAt: Number(row.createdAt),
            updatedAt: Number(row.updatedAt),
            deletedAt: row.deletedAt ? Number(row.deletedAt) : null,
        };
    }

    // -------------------------------------------------
    // FIND MANY (only active)
    // -------------------------------------------------
    async find(): Promise<DetectorEntity[]> {
        const rows = await this.reader.queryAsObjects(`
            SELECT *
            FROM detectors
            WHERE status = 'active'
            ORDER BY name
        `);

        return rows.map(r => this.rowToEntity(r));
    }

    // -------------------------------------------------
    // FIND ONE
    // -------------------------------------------------
    async findOne(options: { where: { key?: string; name?: string }, withDeleted?: boolean }): Promise<DetectorEntity | null> {
        const { key, name } = options.where;

        let sql = `
            SELECT *
            FROM detectors
        `;

        const conditions: string[] = [];

        if (key) conditions.push(`key='${this.esc(key)}'`);
        if (name) conditions.push(`name='${this.esc(name)}'`);

        if (!options.withDeleted) {
            conditions.push(`status='active'`);
        }

        if (conditions.length) sql += ` WHERE ` + conditions.join(` AND `);

        sql += ` LIMIT 1`;

        const row = await this.reader.queryOne(sql);
        return row ? this.rowToEntity(row) : null;
    }

    // -------------------------------------------------
    // CREATE (local only)
    // -------------------------------------------------
    create(data: Partial<DetectorEntity>): DetectorEntity {
        const now = Date.now();

        return {
            key: data.key!,
            name: data.name ?? data.key!,
            options: data.options ?? {},
            status: 'active',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
    }

    // -------------------------------------------------
    // SAVE (insert or update)
    // -------------------------------------------------
    async save(entity: DetectorEntity): Promise<DetectorEntity> {
        const exists = await this.getByKey(entity.key, true);

        if (exists) {
            await this.update(entity.key, {
                name: entity.name,
                options: entity.options,
                updatedAt: Date.now(),
            });
        } else {
            await this.insert(entity);
        }

        return entity;
    }

    // -------------------------------------------------
    // INSERT
    // -------------------------------------------------
    async insert(entity: DetectorEntity): Promise<void> {
        await this.reader.query(`
            INSERT INTO detectors (key, name, options, status, createdAt, updatedAt, deletedAt)
            VALUES (
                '${this.esc(entity.key)}',
                '${this.esc(entity.name)}',
                '${this.esc(JSON.stringify(entity.options))}',
                'active',
                ${entity.createdAt},
                ${entity.updatedAt},
                null
            )
        `);

        this.events.emit('detector.insert', {
            category: 'detector',
            action: 'insert',
            timestamp: Date.now(),
            data: entity,
        });
    }

    // -------------------------------------------------
    // UPDATE
    // -------------------------------------------------
    async update(key: string, patch: Partial<DetectorEntity>): Promise<void> {
        const sets = Object.entries(patch)
            .map(([field, value]) => {
                if (value === undefined) return null;

                if (field === 'options') {
                    return `${field}='${this.esc(JSON.stringify(value))}'`;
                }
                if (typeof value === 'string') {
                    return `${field}='${this.esc(value)}'`;
                }
                return `${field}=${value}`;
            })
            .filter(Boolean)
            .join(',');

        await this.reader.query(`
            UPDATE detectors
            SET ${sets}
            WHERE key='${this.esc(key)}'
        `);

        this.events.emit('detector.update', {
            category: 'detector',
            action: 'update',
            timestamp: Date.now(),
            data: { key, patch },
        });
    }

    // -------------------------------------------------
    // SOFT DELETE (QuestDB-friendly)
    // -------------------------------------------------
    async delete(key: string): Promise<void> {
        const escapedKey = this.esc(key);

        const sql = `
            UPDATE detectors
            SET status='deleted',
                deletedAt=now(),
                updatedAt=now()
            WHERE key='${escapedKey}'
        `;

        await this.reader.query(sql);

        this.events.emit('detector.delete', {
            category: 'detector',
            action: 'delete',
            timestamp: Date.now(),
            data: { key },
        });
    }

    // -------------------------------------------------
    // HELPERS
    // -------------------------------------------------
    async getAll() {
        return this.find();
    }

    async getByKey(key: string, withDeleted = false) {
        return this.findOne({ where: { key }, withDeleted });
    }

    async getByName(name: string, withDeleted = false) {
        return this.findOne({ where: { name }, withDeleted });
    }
}
