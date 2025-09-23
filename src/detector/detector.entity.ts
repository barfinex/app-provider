import { Detector } from "@barfinex/types";
import { Type } from "class-transformer";
import { Column, Entity, ObjectId, ObjectIdColumn, UpdateDateColumn, CreateDateColumn } from "typeorm";

@Entity()
export class DetectorEntity {

    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    key: string;

    @Column()
    name: string;

    @Column({ type: 'json' })
    @Type(() => Object)
    options: Detector;

    @CreateDateColumn({ type: 'timestamptz' })
    created!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated!: Date;
}