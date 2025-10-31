import { Column, Entity, Index, ObjectIdColumn, ObjectId } from "typeorm";

@Entity()
export class OrderEntity {
    @ObjectIdColumn()
    id!: ObjectId;

    @Column({ nullable: true })
    externalId!: string | null;

    @Column()
    connectorType!: string;

    @Column()
    marketType!: string;

    @Index()
    @Column()
    sourceSysname!: string;

    @Index()
    @Column()
    sourceType!: string;

    @Index()
    @Column()
    sourceBaseApiUrl!: string;

    @Column()
    symbol!: string;

    @Column({ nullable: true })
    side!: string | null;

    @Column({ nullable: true })
    type!: string | null;

    @Column({ type: 'decimal', nullable: true })
    price!: number | null;

    @Column({ type: 'bigint' })
    time!: number;

    @Column({ type: 'bigint', nullable: true })
    updateTime!: number | null;

    @Column({ type: 'decimal', nullable: true })
    quantity!: number | null;

    @Column({ type: 'decimal', nullable: true })
    quantityExecuted!: number | null;

    @Column({ type: 'decimal', nullable: true })
    priceClose!: number | null;

    @Column()
    useSandbox!: boolean;

    @Column({ type: 'bigint', nullable: true })
    closeTime!: number | null;
}
