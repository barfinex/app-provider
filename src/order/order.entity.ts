import { Connector } from "@barfinex/types";
import { Column, Entity, PrimaryGeneratedColumn, DeleteDateColumn, Index, ObjectIdColumn, ObjectId, PrimaryColumn } from "typeorm";

@Entity()
export class OrderEntity {

    // @ObjectIdColumn()
    // _id: string;

    // @PrimaryColumn()
    // id: string;


    // @ObjectIdColumn()
    // //@ObjectIdColumn({ generated: false })
    // id: ObjectID;
    @ObjectIdColumn()
    id: ObjectId;

    // @PrimaryGeneratedColumn('increment')
    // id: number

    @Column({ nullable: true })
    externalId: string

    @Column()
    connectorType: string

    @Column()
    marketType: string

    @Index()
    @Column()
    sourceSysname: string

    @Index()
    @Column()
    sourceType: string

    @Index()
    @Column()
    sourceBaseApiUrl: string

    @Column()
    symbol: string

    @Column()
    side: string

    @Column()
    type: string

    @Column({ type: 'decimal' })
    price: number

    @Column({ type: 'bigint' })
    time: number

    @Column({ type: 'bigint', nullable: true })
    updateTime: number

    @Column({ type: 'decimal' })
    quantity: number

    @Column({ type: 'decimal', nullable: true })
    quantityExecuted: number

    // @Column({ type: 'decimal', nullable: true })
    // priceStop: number

    @Column({ type: 'decimal', nullable: true })
    priceClose: number

    // @Column({ nullable: true })
    // isClose: boolean

    @Column()
    useSandbox: boolean

    @Column({ type: 'bigint', nullable: true })
    closeTime?: number
}

