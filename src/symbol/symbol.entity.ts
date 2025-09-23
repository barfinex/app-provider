import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ObjectIdColumn } from 'typeorm';

@Entity()
export class SymbolEntity {
    @ObjectIdColumn()
    id: number;

    @Column()
    baseAsset: string;

    @Column()
    quoteAsset: string;

    @Column()
    symbol: string;

    @Column()
    status: string;

    @Column()
    connectorType: string;

    @Column()
    marketType: string;

    @UpdateDateColumn()
    updatedAt: Date;

    @CreateDateColumn()
    createdAt: Date;
}